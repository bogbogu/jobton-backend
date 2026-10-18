import { TELEGRAM_USERNAME_PATTERN } from "../../models/telegramChannel.model.js";

// The ONLY outbound request the poller ever makes: a public channel preview
// page on t.me. The URL is assembled from a fixed prefix plus a validated
// username (and an integer cursor). No URL found inside a post is ever fetched.

const BASE_URL = "https://t.me/s/";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

export async function fetchChannelPage(
  username,
  {
    beforeId,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
  } = {}
) {
  if (typeof username !== "string" || !TELEGRAM_USERNAME_PATTERN.test(username)) {
    throw new Error("Invalid Telegram channel username.");
  }

  let url = `${BASE_URL}${username}`;
  if (beforeId !== undefined && beforeId !== null) {
    if (!Number.isSafeInteger(beforeId) || beforeId <= 0) {
      throw new Error("Invalid beforeId.");
    }
    url += `?before=${beforeId}`;
  }

  if (typeof fetchImpl !== "function") {
    throw new Error("No fetch implementation available.");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; JobtonIngest/1.0)",
          Accept: "text/html",
        },
      });
    } catch (error) {
      if (controller.signal.aborted) throw new Error("Telegram request timed out.");
      throw new Error(`Telegram request failed: ${String(error?.message || "network error").slice(0, 120)}`);
    }

    // Redirects (3xx) are NOT followed: a redirect from t.me/s/<x> usually
    // means "channel has no web preview", and following it could lead anywhere.
    if (response.status !== 200) {
      await response.body?.cancel?.().catch(() => {});
      throw new Error(`Telegram returned HTTP ${response.status}.`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (!/html/i.test(contentType)) {
      await response.body?.cancel?.().catch(() => {});
      throw new Error("Telegram returned a non-HTML response.");
    }

    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      await response.body?.cancel?.().catch(() => {});
      throw new Error("Telegram response too large.");
    }

    if (!response.body) {
      throw new Error("Telegram returned an empty response.");
    }

    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          controller.abort();
          await reader.cancel().catch(() => {});
          throw new Error("Telegram response too large.");
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error?.message === "Telegram response too large.") throw error;
      if (controller.signal.aborted) throw new Error("Telegram request timed out.");
      throw new Error("Telegram response could not be read.");
    }

    return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
  } finally {
    clearTimeout(timer);
  }
}
