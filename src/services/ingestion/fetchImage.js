import { createHash } from "node:crypto";
import { normalizeTelegramImageUrl } from "../../utils/telegramImageUrl.js";

// Downloads ONE post photo from Telegram's CDN into memory.
//
// The URL comes from a public web page, so it is treated as hostile:
//  - re-validated against the CDN allow-list (https, no credentials, no port);
//  - redirects are never followed automatically: one is accepted only when it
//    points at another allow-listed https URL, at most MAX_REDIRECTS times;
//  - the whole request (headers AND body) has a hard time limit;
//  - the body is streamed and aborted as soon as it passes MAX_IMAGE_BYTES;
//  - the Content-Type must be one of four image types AND the first bytes must
//    be the signature of that type;
//  - nothing is written to disk or the database, and nothing is logged here.
//
// Never throws. Returns { ok: true, mediaType, base64, sha256 } (sha256 = hex digest
// of the bytes, used to recognise the same picture again; the bytes are not kept) or
// { ok: false, reason, transient }. `reason` is a short stable code (never a
// URL, a response body or an error message); `transient` says whether trying
// again on a later run could help (timeout, network error, 429/5xx).

// The API takes about 5 MB of base64 per image; 3.5 MiB of bytes is ~4.7 MB encoded.
export const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024;
export const IMAGE_TIMEOUT_MS = 15_000;
export const MAX_REDIRECTS = 2;

export const IMAGE_FAILURES = Object.freeze({
  URL_NOT_ALLOWED: "url_not_allowed",
  REDIRECT_NOT_ALLOWED: "redirect_not_allowed",
  TOO_MANY_REDIRECTS: "too_many_redirects",
  HTTP_ERROR: "http_error",
  BAD_CONTENT_TYPE: "bad_content_type",
  TOO_LARGE: "too_large",
  BAD_IMAGE: "bad_image",
  TIMEOUT: "timeout",
  NETWORK: "network",
});

const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const startsWith = (bytes, signature, offset = 0) =>
  bytes.length >= offset + signature.length && signature.every((value, index) => bytes[offset + index] === value);

const ascii = (text) => [...text].map((char) => char.charCodeAt(0));

// True when the leading bytes are a real signature of the declared type.
export function matchesImageSignature(mediaType, bytes) {
  switch (mediaType) {
    case "image/jpeg":
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case "image/png":
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/gif":
      return startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"));
    case "image/webp":
      return startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8);
    default:
      return false;
  }
}

const failure = (reason, transient = false) => ({ ok: false, reason, transient });

class Stop extends Error {
  constructor(result) {
    super("stop");
    this.result = result;
  }
}

// Releases a response body we do not intend to read.
const discard = async (response) => {
  try {
    await response?.body?.cancel?.();
  } catch {
    // nothing to clean up
  }
};

// Reads the body up to `maxBytes`. Throws Stop(too_large) past the limit.
async function readCapped(response, maxBytes, controller) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    controller.abort();
    await discard(response);
    throw new Stop(failure(IMAGE_FAILURES.TOO_LARGE));
  }

  const reader = response.body?.getReader?.();
  if (!reader) throw new Stop(failure(IMAGE_FAILURES.BAD_IMAGE));

  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.length === 0) continue;

    total += value.length;
    if (total > maxBytes) {
      controller.abort();
      try {
        await reader.cancel();
      } catch {
        // already closed
      }
      throw new Stop(failure(IMAGE_FAILURES.TOO_LARGE));
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)), total);
}

async function download(startUrl, { fetchImpl, maxBytes, maxRedirects, controller }) {
  let current = normalizeTelegramImageUrl(startUrl);
  if (!current) throw new Stop(failure(IMAGE_FAILURES.URL_NOT_ALLOWED));

  for (let hop = 0; ; hop += 1) {
    const response = await fetchImpl(current, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: { accept: "image/jpeg,image/png,image/webp,image/gif" },
    });

    if (REDIRECT_STATUSES.has(response.status)) {
      await discard(response);
      if (hop >= maxRedirects) throw new Stop(failure(IMAGE_FAILURES.TOO_MANY_REDIRECTS));

      const location = response.headers?.get?.("location");
      let next = null;
      try {
        next = location ? normalizeTelegramImageUrl(new URL(location, current).href) : null;
      } catch {
        next = null;
      }
      if (!next) throw new Stop(failure(IMAGE_FAILURES.REDIRECT_NOT_ALLOWED));
      current = next;
      continue;
    }

    if (response.status !== 200) {
      await discard(response);
      const transient = response.status === 429 || response.status >= 500;
      throw new Stop(failure(IMAGE_FAILURES.HTTP_ERROR, transient));
    }

    const mediaType = String(response.headers?.get?.("content-type") || "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (!ALLOWED_TYPES.has(mediaType)) {
      await discard(response);
      throw new Stop(failure(IMAGE_FAILURES.BAD_CONTENT_TYPE));
    }

    const bytes = await readCapped(response, maxBytes, controller);
    if (bytes.length === 0 || !matchesImageSignature(mediaType, bytes)) {
      throw new Stop(failure(IMAGE_FAILURES.BAD_IMAGE));
    }

    return {
      ok: true,
      mediaType,
      base64: bytes.toString("base64"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }
}

export async function fetchImage(
  url,
  {
    fetchImpl = globalThis.fetch,
    timeoutMs = IMAGE_TIMEOUT_MS,
    maxBytes = MAX_IMAGE_BYTES,
    maxRedirects = MAX_REDIRECTS,
  } = {}
) {
  if (typeof fetchImpl !== "function") return failure(IMAGE_FAILURES.NETWORK);

  const controller = new AbortController();
  let timer;
  let timedOut = false;

  // Racing the timer makes the limit hold even for a fetch that ignores the signal.
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Stop(failure(IMAGE_FAILURES.TIMEOUT, true)));
    }, timeoutMs);
  });

  const work = download(url, { fetchImpl, maxBytes, maxRedirects, controller });
  // If the deadline wins, a later rejection of `work` must not become unhandled.
  work.catch(() => {});

  try {
    return await Promise.race([work, deadline]);
  } catch (error) {
    if (error instanceof Stop) return error.result;
    // The error object is dropped on purpose: it can quote the URL.
    return timedOut ? failure(IMAGE_FAILURES.TIMEOUT, true) : failure(IMAGE_FAILURES.NETWORK, true);
  } finally {
    clearTimeout(timer);
    deadline.catch(() => {});
  }
}
