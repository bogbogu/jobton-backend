import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseChannelHtml } from "../../src/services/ingestion/telegramParse.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, "fixtures", "channel-page.html"), "utf8");

describe("parseChannelHtml", () => {
  const posts = parseChannelHtml(html, "tohire_ng");
  const byId = Object.fromEntries(posts.map((post) => [post.messageId, post]));

  it("returns only entries of the requested channel (case-insensitive)", () => {
    expect(posts.map((post) => post.messageId)).toEqual([10325, 10329, 10330, 10331]);
  });

  it("decodes entities, turns <br> into newlines and reads the date", () => {
    const post = byId[10325];
    expect(post.text).toContain("University Press Plc is hiring!");
    expect(post.text).not.toContain("&#33;");
    expect(post.text).toContain("Apply here>>>https://bit.ly/4xG6zdY");
    expect(post.text).toContain("Position: Manager (Accounts)\n\nLocation: Ibadan");
    expect(post.postedAt.toISOString()).toBe("2026-09-29T09:59:26.000Z");
    expect(post.hasImage).toBe(true);
  });

  it("keeps hashtags as plain labels without relative hrefs", () => {
    expect(byId[10325].text).toContain("#Jobs #IbadanJobs");
    expect(byId[10325].text).not.toContain("?q=");
  });

  it("keeps 'label (href)' when an anchor label differs from its href", () => {
    const post = byId[10329];
    expect(post.text).toContain(
      "Apply on our careers page (https://jobs.smartrecruiters.com/ThePlace1/744000152481767-junior-it-support-lagos-mainland)"
    );
    expect(post.text).toContain('& mention "IT"');
    expect(post.links).toEqual([
      {
        href: "https://jobs.smartrecruiters.com/ThePlace1/744000152481767-junior-it-support-lagos-mainland",
        label: "Apply on our careers page",
      },
    ]);
  });

  it("records an anchor whose label is the URL itself once, without duplicating text", () => {
    expect(byId[10325].links).toEqual([{ href: "https://bit.ly/4xG6zdY", label: "https://bit.ly/4xG6zdY" }]);
  });

  it("handles image-only posts", () => {
    expect(byId[10330]).toMatchObject({ text: "", links: [], hasImage: true });
  });

  it("ignores unsafe/relative hrefs and script content, and the quoted reply text", () => {
    const post = byId[10331];
    expect(post.text).toContain("E-Sales Officer at United Bank for Africa (UBA)");
    expect(post.text).toContain("Send CV to: careers@ubagroup.com");
    expect(post.text).not.toContain("alert");
    expect(post.text).not.toContain("javascript");
    expect(post.text).not.toContain("Quoted reply");
    expect(post.links).toEqual([]);
  });

  it("caps the text at 4000 chars and the links at 10", () => {
    const anchors = Array.from({ length: 15 }, (_, i) => `<a href="https://example${i}.com/a">l${i}</a>`).join(" ");
    const big = `<div class="tgme_widget_message_wrap"><div data-post="chan_x1/5"><div class="tgme_widget_message_text">${"x".repeat(6000)} ${anchors}</div></div></div>`;
    const [post] = parseChannelHtml(big, "chan_x1");
    expect(post.text.length).toBeLessThanOrEqual(4000);
  });

  it("returns an empty list for pages without messages", () => {
    expect(parseChannelHtml("<html><body>nothing</body></html>", "tohire_ng")).toEqual([]);
  });

  it("limits links to 10", () => {
    const anchors = Array.from({ length: 15 }, (_, i) => `<a href="https://example${i}.com/a">l${i}</a>`).join(" ");
    const page = `<div class="tgme_widget_message_wrap"><div data-post="chan_x1/5"><div class="tgme_widget_message_text">${anchors}</div></div></div>`;
    const [post] = parseChannelHtml(page, "chan_x1");
    expect(post.links).toHaveLength(10);
  });
});
