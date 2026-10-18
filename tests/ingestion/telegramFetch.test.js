import { describe, expect, it } from "vitest";
import { fetchChannelPage } from "../../src/services/ingestion/telegramFetch.js";
import { htmlResponse, makeFakeFetch } from "./helpers.js";

describe("fetchChannelPage", () => {
  it.each(["../x", "a b", "ab", "x".repeat(33), "Tohire_NG", "1abcde", "abc/def", "abcde?x=1", "abcde\n", ""])(
    "rejects username %j before any request",
    async (username) => {
      const fetchImpl = makeFakeFetch({});
      await expect(fetchChannelPage(username, { fetchImpl })).rejects.toThrow(/username/i);
      expect(fetchImpl.calls).toHaveLength(0);
    }
  );

  it.each([0, -5, 1.5, "12", NaN, Infinity, Number.MAX_SAFE_INTEGER + 10, "1;rm", {}])(
    "rejects beforeId %j",
    async (beforeId) => {
      const fetchImpl = makeFakeFetch({});
      await expect(fetchChannelPage("tohire_ng", { beforeId, fetchImpl })).rejects.toThrow(/beforeId/);
      expect(fetchImpl.calls).toHaveLength(0);
    }
  );

  it("requests only the fixed https://t.me/s/ URL, without following redirects", async () => {
    const fetchImpl = makeFakeFetch({
      "https://t.me/s/tohire_ng": "<html>first</html>",
      "https://t.me/s/tohire_ng?before=10325": "<html>second</html>",
    });

    expect(await fetchChannelPage("tohire_ng", { fetchImpl })).toBe("<html>first</html>");
    expect(await fetchChannelPage("tohire_ng", { beforeId: 10325, fetchImpl })).toBe("<html>second</html>");

    expect(fetchImpl.calls.map((call) => call.url)).toEqual([
      "https://t.me/s/tohire_ng",
      "https://t.me/s/tohire_ng?before=10325",
    ]);
    for (const call of fetchImpl.calls) {
      expect(call.options.redirect).toBe("manual");
      expect(call.options.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("treats redirects as errors", async () => {
    const fetchImpl = makeFakeFetch({
      "https://t.me/s/tohire_ng": () =>
        new Response(null, { status: 302, headers: { location: "https://evil.example/" } }),
    });
    await expect(fetchChannelPage("tohire_ng", { fetchImpl })).rejects.toThrow(/HTTP 302/);
    expect(fetchImpl.calls).toHaveLength(1);
  });

  it("treats non-200 responses as errors", async () => {
    const fetchImpl = makeFakeFetch({});
    await expect(fetchChannelPage("tohire_ng", { fetchImpl })).rejects.toThrow(/HTTP 404/);
  });

  it("requires an html content type", async () => {
    const fetchImpl = makeFakeFetch({
      "https://t.me/s/tohire_ng": () =>
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    });
    await expect(fetchChannelPage("tohire_ng", { fetchImpl })).rejects.toThrow(/non-HTML/);
  });

  it("aborts a body that exceeds maxBytes", async () => {
    const fetchImpl = makeFakeFetch({
      "https://t.me/s/tohire_ng": () => htmlResponse("a".repeat(5000)),
    });
    await expect(fetchChannelPage("tohire_ng", { fetchImpl, maxBytes: 1000 })).rejects.toThrow(/too large/);
  });

  it("aborts a streamed body that exceeds maxBytes without a content-length", async () => {
    const stream = new ReadableStream({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("b".repeat(400)));
      },
    });
    const fetchImpl = makeFakeFetch({
      "https://t.me/s/tohire_ng": () =>
        new Response(stream, { status: 200, headers: { "content-type": "text/html" } }),
    });
    await expect(fetchChannelPage("tohire_ng", { fetchImpl, maxBytes: 1000 })).rejects.toThrow(/too large/);
  });

  it("times out a request that never answers", async () => {
    const fetchImpl = (url, { signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    await expect(fetchChannelPage("tohire_ng", { fetchImpl, timeoutMs: 20 })).rejects.toThrow(/timed out/);
  });

  it("wraps network errors in a short message", async () => {
    const fetchImpl = makeFakeFetch({ "https://t.me/s/tohire_ng": new Error("getaddrinfo ENOTFOUND t.me") });
    await expect(fetchChannelPage("tohire_ng", { fetchImpl })).rejects.toThrow(/Telegram request failed/);
  });
});
