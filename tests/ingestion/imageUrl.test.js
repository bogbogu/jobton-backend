import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  filterAllowedImageUrls,
  isAllowedTelegramImageUrl,
  normalizeTelegramImageUrl,
} from "../../src/utils/telegramImageUrl.js";
import {
  isAllowedTelegramImageUrl as reExported,
  parseChannelHtml,
} from "../../src/services/ingestion/telegramParse.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, "fixtures", "photo-page.html"), "utf8");

describe("isAllowedTelegramImageUrl", () => {
  it("accepts Telegram CDN hosts over https", () => {
    for (const url of [
      "https://cdn4.telesco.pe/file/x.jpg",
      "https://cdn1.cdn-telegram.org/file/x.jpg?token=1",
      "https://cdn.telesco.pe/a.png",
      "https://cdn12.telesco.pe/a.png",
    ]) {
      expect(isAllowedTelegramImageUrl(url), url).toBe(true);
    }
  });

  it("is case-insensitive on the host and normalizes it", () => {
    expect(isAllowedTelegramImageUrl("HTTPS://CDN4.TELESCO.PE/File/X.jpg")).toBe(true);
    expect(normalizeTelegramImageUrl("HTTPS://CDN4.TELESCO.PE/File/X.jpg")).toBe("https://cdn4.telesco.pe/File/X.jpg");
  });

  it("accepts the default https port written out, and normalizes it away", () => {
    expect(normalizeTelegramImageUrl("https://cdn4.telesco.pe:443/x.jpg")).toBe("https://cdn4.telesco.pe/x.jpg");
  });

  it("rejects look-alike and unrelated hosts", () => {
    for (const url of [
      "https://cdn1.telesco.pe.evil.com/x.jpg",
      "https://evil.com/cdn1.telesco.pe/x.jpg",
      "https://evil.com/?u=https://cdn1.telesco.pe/x.jpg",
      "https://xcdn1.telesco.pe/x.jpg",
      "https://cdn1.telesco.pe.evil.com./x.jpg",
      "https://cdn1.telesco.pe./x.jpg",
      "https://cdn1-telesco.pe/x.jpg",
      "https://cdn1.telesco.pee/x.jpg",
      "https://sub.cdn1.telesco.pe/x.jpg",
      "https://cdnx.telesco.pe/x.jpg",
      "https://telesco.pe/x.jpg",
      "https://t.me/x.jpg",
    ]) {
      expect(isAllowedTelegramImageUrl(url), url).toBe(false);
    }
  });

  it("rejects other schemes", () => {
    for (const url of [
      "http://cdn1.telesco.pe/x.jpg",
      "ftp://cdn1.telesco.pe/x.jpg",
      "//cdn1.telesco.pe/x.jpg",
      "data:image/png;base64,AAAA",
      "javascript:alert(1)",
      "file:///etc/passwd",
    ]) {
      expect(isAllowedTelegramImageUrl(url), url).toBe(false);
    }
  });

  it("rejects userinfo, including the classic '@' tricks", () => {
    for (const url of [
      "https://user:pass@cdn1.telesco.pe/x.jpg",
      "https://user@cdn1.telesco.pe/x.jpg",
      "https://cdn1.telesco.pe@evil.com/x.jpg",
      "https://cdn1.telesco.pe:pw@evil.com/x.jpg",
      "https://evil.com\\@cdn1.telesco.pe/x.jpg",
    ]) {
      expect(isAllowedTelegramImageUrl(url), url).toBe(false);
    }
  });

  it("rejects non-default ports", () => {
    for (const url of [
      "https://cdn1.telesco.pe:8443/x.jpg",
      "https://cdn1.telesco.pe:80/x.jpg",
      "https://cdn1.telesco.pe:22/x.jpg",
    ]) {
      expect(isAllowedTelegramImageUrl(url), url).toBe(false);
    }
  });

  it("rejects IP hosts and localhost", () => {
    for (const url of [
      "https://127.0.0.1/x.jpg",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/x.jpg",
      "https://2130706433/x.jpg",
      "https://localhost/x.jpg",
      "https://0x7f.0.0.1/x.jpg",
    ]) {
      expect(isAllowedTelegramImageUrl(url), url).toBe(false);
    }
  });

  it("rejects whitespace, control characters, over-long values and non-strings", () => {
    expect(isAllowedTelegramImageUrl(" https://cdn1.telesco.pe/x.jpg")).toBe(false);
    expect(isAllowedTelegramImageUrl("https://cdn1.telesco.pe/x.jpg\n")).toBe(false);
    expect(isAllowedTelegramImageUrl("https://cdn1.telesco.pe/x .jpg")).toBe(false);
    expect(isAllowedTelegramImageUrl("https://cdn1.telesco.pe/x\u0000.jpg")).toBe(false);
    expect(isAllowedTelegramImageUrl(`https://cdn1.telesco.pe/${"a".repeat(3000)}`)).toBe(false);
    for (const value of [undefined, null, 42, {}, [], ""]) {
      expect(isAllowedTelegramImageUrl(value)).toBe(false);
    }
  });

  it("is the same helper that telegramParse exports", () => {
    expect(reExported).toBe(isAllowedTelegramImageUrl);
  });
});

describe("filterAllowedImageUrls", () => {
  it("keeps allowed urls, unique, in order, at most 3", () => {
    const urls = [
      "https://cdn1.telesco.pe/a.jpg",
      "https://evil.example/b.jpg",
      "https://cdn1.telesco.pe/a.jpg",
      "https://cdn2.telesco.pe/c.jpg",
      "https://cdn3.telesco.pe/d.jpg",
      "https://cdn4.telesco.pe/e.jpg",
    ];
    expect(filterAllowedImageUrls(urls)).toEqual([
      "https://cdn1.telesco.pe/a.jpg",
      "https://cdn2.telesco.pe/c.jpg",
      "https://cdn3.telesco.pe/d.jpg",
    ]);
    expect(filterAllowedImageUrls(urls, 1)).toHaveLength(1);
  });

  it("returns [] for anything that is not an array", () => {
    expect(filterAllowedImageUrls(undefined)).toEqual([]);
    expect(filterAllowedImageUrls("https://cdn1.telesco.pe/a.jpg")).toEqual([]);
  });
});

describe("parseChannelHtml photo urls", () => {
  const posts = parseChannelHtml(html, "flyers_ng");
  const byId = Object.fromEntries(posts.map((post) => [post.messageId, post]));

  it("reads the photos of an album in page order, normalized, capped at 3", () => {
    expect(byId[101].hasImage).toBe(true);
    expect(byId[101].imageUrls).toEqual([
      "https://cdn4.telesco.pe/file/one.jpg",
      "https://cdn1.cdn-telegram.org/file/two.jpg?x=1",
      "https://cdn2.telesco.pe/file/three.jpg",
    ]);
  });

  it("drops hostile, non-https and malformed urls but keeps hasImage", () => {
    expect(byId[110].hasImage).toBe(true);
    expect(byId[110].imageUrls).toEqual([]);
  });

  it("does not take the photo of a quoted message", () => {
    expect(byId[120].imageUrls).toEqual([]);
  });

  it("gives [] for a post without a photo", () => {
    expect(byId[130].hasImage).toBe(false);
    expect(byId[130].imageUrls).toEqual([]);
  });
});
