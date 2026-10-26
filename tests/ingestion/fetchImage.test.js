import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  IMAGE_FAILURES,
  MAX_IMAGE_BYTES,
  fetchImage,
  matchesImageSignature,
} from "../../src/services/ingestion/fetchImage.js";

const URL_OK = "https://cdn4.telesco.pe/file/flyer.jpg";

// Smallest byte strings that carry each format's signature.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const GIF = Buffer.concat([Buffer.from("GIF89a"), Buffer.from([1, 2, 3])]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([4, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.from([1])]);

const imageResponse = (bytes, type = "image/jpeg", init = {}) =>
  new Response(bytes, { status: 200, headers: { "content-type": type }, ...init });

const redirect = (location, status = 302) => new Response(null, { status, headers: { location } });

// A fetch serving a queue of responses (or functions), recording every call.
const queueFetch = (...items) => {
  const calls = [];
  const fake = async (url, options) => {
    calls.push({ url: String(url), options });
    const item = items.shift();
    if (item instanceof Error) throw item;
    return typeof item === "function" ? item(url, options) : item;
  };
  fake.calls = calls;
  return fake;
};

describe("fetchImage", () => {
  it("returns the media type and base64 of a valid image, requesting without following redirects", async () => {
    const fetchImpl = queueFetch(imageResponse(JPEG));
    const result = await fetchImage(URL_OK, { fetchImpl });

    expect(result).toEqual({
      ok: true,
      mediaType: "image/jpeg",
      base64: JPEG.toString("base64"),
      sha256: createHash("sha256").update(JPEG).digest("hex"),
    });
    expect(fetchImpl.calls).toHaveLength(1);
    expect(fetchImpl.calls[0].options.redirect).toBe("manual");
    expect(fetchImpl.calls[0].options.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ["image/png", PNG],
    ["image/gif", GIF],
    ["image/webp", WEBP],
  ])("accepts %s with its signature", async (type, bytes) => {
    const result = await fetchImage(URL_OK, { fetchImpl: queueFetch(imageResponse(bytes, type)) });
    expect(result).toMatchObject({ ok: true, mediaType: type });
  });

  it("ignores content-type parameters and case", async () => {
    const result = await fetchImage(URL_OK, { fetchImpl: queueFetch(imageResponse(PNG, "Image/PNG; charset=binary")) });
    expect(result).toMatchObject({ ok: true, mediaType: "image/png" });
  });

  it("refuses a URL off the allow-list without calling fetch", async () => {
    const fetchImpl = vi.fn();
    for (const url of ["https://evil.example/x.jpg", "http://cdn4.telesco.pe/x.jpg", "https://u:p@cdn4.telesco.pe/x.jpg", "nonsense"]) {
      expect(await fetchImage(url, { fetchImpl })).toEqual({ ok: false, reason: IMAGE_FAILURES.URL_NOT_ALLOWED, transient: false });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a wrong content type", async () => {
    for (const type of ["text/html", "image/svg+xml", "application/octet-stream", ""]) {
      const result = await fetchImage(URL_OK, { fetchImpl: queueFetch(imageResponse(JPEG, type)) });
      expect(result, type).toEqual({ ok: false, reason: IMAGE_FAILURES.BAD_CONTENT_TYPE, transient: false });
    }
  });

  it("rejects bytes that do not match the declared type", async () => {
    const cases = [
      [PNG, "image/jpeg"],
      [JPEG, "image/png"],
      [Buffer.from("<html>not an image</html>"), "image/jpeg"],
      [Buffer.from("RIFFxxxxWAVEdata"), "image/webp"],
      [Buffer.alloc(0), "image/jpeg"],
    ];
    for (const [bytes, type] of cases) {
      const result = await fetchImage(URL_OK, { fetchImpl: queueFetch(imageResponse(bytes, type)) });
      expect(result, type).toEqual({ ok: false, reason: IMAGE_FAILURES.BAD_IMAGE, transient: false });
    }
  });

  it("aborts a stream that passes the size cap, without reading all of it", async () => {
    let pulled = 0;
    const stream = new ReadableStream({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(1024).fill(0xff));
        if (pulled > 10_000) controller.close();
      },
    });
    const result = await fetchImage(URL_OK, {
      fetchImpl: queueFetch(new Response(stream, { status: 200, headers: { "content-type": "image/jpeg" } })),
      maxBytes: 4096,
    });

    expect(result).toEqual({ ok: false, reason: IMAGE_FAILURES.TOO_LARGE, transient: false });
    expect(pulled).toBeLessThan(100);
  });

  it("rejects an oversize content-length before reading the body", async () => {
    const response = imageResponse(JPEG, "image/jpeg", { headers: { "content-type": "image/jpeg", "content-length": String(MAX_IMAGE_BYTES + 1) } });
    const result = await fetchImage(URL_OK, { fetchImpl: queueFetch(response) });
    expect(result).toEqual({ ok: false, reason: IMAGE_FAILURES.TOO_LARGE, transient: false });
  });

  it("defaults to a 3.5 MiB cap (the API takes about 5 MB of base64)", () => {
    expect(MAX_IMAGE_BYTES).toBe(3.5 * 1024 * 1024);
    expect(Math.ceil((MAX_IMAGE_BYTES * 4) / 3)).toBeLessThan(5 * 1000 * 1000);
  });

  it("treats a redirect off the allow-list as a failure and never requests the target", async () => {
    for (const target of [
      "https://evil.example/x.jpg",
      "http://cdn4.telesco.pe/x.jpg",
      "https://cdn4.telesco.pe.evil.example/x.jpg",
      "https://169.254.169.254/latest",
      "https://user:pw@cdn4.telesco.pe/x.jpg",
    ]) {
      const fetchImpl = queueFetch(redirect(target));
      const result = await fetchImage(URL_OK, { fetchImpl });
      expect(result, target).toEqual({ ok: false, reason: IMAGE_FAILURES.REDIRECT_NOT_ALLOWED, transient: false });
      expect(fetchImpl.calls).toHaveLength(1);
    }
  });

  it("treats a redirect without a location as a failure", async () => {
    const result = await fetchImage(URL_OK, { fetchImpl: queueFetch(new Response(null, { status: 302 })) });
    expect(result.reason).toBe(IMAGE_FAILURES.REDIRECT_NOT_ALLOWED);
  });

  it("follows a redirect to another allow-listed host, including a relative one", async () => {
    const fetchImpl = queueFetch(
      redirect("https://cdn1.cdn-telegram.org/file/other.jpg"),
      redirect("/file/final.jpg", 301),
      imageResponse(JPEG)
    );
    const result = await fetchImage(URL_OK, { fetchImpl });

    expect(result).toMatchObject({ ok: true, mediaType: "image/jpeg" });
    expect(fetchImpl.calls.map((call) => call.url)).toEqual([
      URL_OK,
      "https://cdn1.cdn-telegram.org/file/other.jpg",
      "https://cdn1.cdn-telegram.org/file/final.jpg",
    ]);
    expect(fetchImpl.calls.every((call) => call.options.redirect === "manual")).toBe(true);
  });

  it("gives up after 2 redirect hops", async () => {
    const fetchImpl = queueFetch(
      redirect("https://cdn1.telesco.pe/a.jpg"),
      redirect("https://cdn2.telesco.pe/b.jpg"),
      redirect("https://cdn3.telesco.pe/c.jpg"),
      imageResponse(JPEG)
    );
    const result = await fetchImage(URL_OK, { fetchImpl });
    expect(result).toEqual({ ok: false, reason: IMAGE_FAILURES.TOO_MANY_REDIRECTS, transient: false });
    expect(fetchImpl.calls).toHaveLength(3);
  });

  it("times out a request that never answers (even if it ignores the abort signal)", async () => {
    const fetchImpl = queueFetch(() => new Promise(() => {}));
    const result = await fetchImage(URL_OK, { fetchImpl, timeoutMs: 30 });
    expect(result).toEqual({ ok: false, reason: IMAGE_FAILURES.TIMEOUT, transient: true });
  });

  it("times out a body that stalls half way, and aborts the request", async () => {
    let signal;
    const fetchImpl = async (url, options) => {
      signal = options.signal;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(JPEG));
          // never closes
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "image/jpeg" } });
    };
    const result = await fetchImage(URL_OK, { fetchImpl, timeoutMs: 30 });
    expect(result).toEqual({ ok: false, reason: IMAGE_FAILURES.TIMEOUT, transient: true });
    expect(signal.aborted).toBe(true);
  });

  it("classifies HTTP statuses: 5xx and 429 are transient, other errors are not", async () => {
    for (const [status, transient] of [[500, true], [503, true], [429, true], [404, false], [403, false], [410, false]]) {
      const result = await fetchImage(URL_OK, { fetchImpl: queueFetch(new Response("nope", { status })) });
      expect(result, String(status)).toEqual({ ok: false, reason: IMAGE_FAILURES.HTTP_ERROR, transient });
    }
  });

  it("never throws and never leaks the error: a network error is a short transient code", async () => {
    const boom = new Error("connect ECONNREFUSED https://cdn4.telesco.pe/secret?token=abc");
    const result = await fetchImage(URL_OK, { fetchImpl: queueFetch(boom) });
    expect(result).toEqual({ ok: false, reason: IMAGE_FAILURES.NETWORK, transient: true });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("does not write anything to disk or log", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    await fetchImage(URL_OK, { fetchImpl: queueFetch(imageResponse(JPEG)) });
    await fetchImage(URL_OK, { fetchImpl: queueFetch(new Error("x")) });
    expect(log).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    log.mockRestore();
    info.mockRestore();
  });
});

describe("matchesImageSignature", () => {
  it("checks each format and rejects unknown types", () => {
    expect(matchesImageSignature("image/jpeg", JPEG)).toBe(true);
    expect(matchesImageSignature("image/png", PNG)).toBe(true);
    expect(matchesImageSignature("image/gif", GIF)).toBe(true);
    expect(matchesImageSignature("image/webp", WEBP)).toBe(true);
    expect(matchesImageSignature("image/jpeg", PNG)).toBe(false);
    expect(matchesImageSignature("image/bmp", PNG)).toBe(false);
    expect(matchesImageSignature("image/png", Buffer.from([0x89, 0x50]))).toBe(false);
  });
});
