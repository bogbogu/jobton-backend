import * as cheerio from "cheerio";
import { cleanText, isSafeHttpUrl } from "../../utils/validators.utils.js";
import {
  MAX_IMAGE_URLS_PER_POST,
  isAllowedTelegramImageUrl,
  normalizeTelegramImageUrl,
} from "../../utils/telegramImageUrl.js";

export { isAllowedTelegramImageUrl };

const MAX_TEXT_CHARS = 4000;
const MAX_LINKS = 10;
const MAX_LABEL_CHARS = 300;
const DATA_POST = /^([A-Za-z0-9_]+)\/(\d+)$/;

const SKIPPED_TAGS = new Set(["script", "style", "template", "noscript"]);

// "https://example.com/" and "example.com" are the same destination for the
// purpose of deciding whether a link label needs to be repeated next to it.
// Linear-time replacement for a trailing-slash regex (quadratic on a long run of slashes).
const stripTrailingSlashes = (value) => {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end -= 1;
  return value.slice(0, end);
};

// Inputs are capped first: labels and hrefs come from untrusted pages.
const looseUrl = (value) =>
  stripTrailingSlashes(
    String(value)
      .slice(0, 2100)
      .trim()
      .toLowerCase()
      .replace(/^https?:[/][/]/, '')
      .replace(/^www[.]/, '')
  );

// Walks a cheerio/htmlparser node tree and returns plain text. Entities are
// already decoded by the parser (&#33; -> "!"). <br> becomes a newline.
// Anchors are collected into `links` as a side effect.
function nodeText(node, links) {
  if (node.type === "text") return node.data;
  if (node.type !== "tag") return "";

  const name = node.name.toLowerCase();
  if (SKIPPED_TAGS.has(name)) return "";
  if (name === "br") return "\n";

  const inner = (node.children || []).map((child) => nodeText(child, links)).join("");

  if (name !== "a") return inner;

  const href = (node.attribs?.href || "").trim();
  if (!isSafeHttpUrl(href)) {
    // hashtags (?q=%23x), mailto:, tel:, javascript: ...: keep the visible label only
    return inner;
  }

  const label = inner.replace(/\s+/g, " ").trim();
  if (!links.some((link) => link.href === href) && links.length < MAX_LINKS) {
    links.push({ href, label: label.slice(0, MAX_LABEL_CHARS) });
  }

  if (!label || looseUrl(label) === looseUrl(href)) return href;
  return `${label} (${href})`;
}

// Linear-time throughout: the raw text is capped BEFORE any regex runs, and
// per-line trailing whitespace is removed with trimEnd() instead of a
// whitespace-then-newline regex (quadratic on a long run of spaces).
const MAX_RAW_CHARS = MAX_TEXT_CHARS * 5;

function normalizeText(raw) {
  const tidy = String(raw)
    .slice(0, MAX_RAW_CHARS)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
  return cleanText(tidy).slice(0, MAX_TEXT_CHARS).trim();
}

// The photo of a message is the background image of its photo wrap:
//   style="width:800px;background-image:url('https://cdn4.telesco.pe/file/x.jpg')"
// One alternative per quoting style; none of them can backtrack into another.
const BACKGROUND_URL = /url\(\s*(?:'([^']*)'|"([^"]*)"|([^)\s'"]*))\s*\)/i;
const MAX_STYLE_CHARS = 3000;

// Allowed photo URLs of one message (at most MAX_IMAGE_URLS_PER_POST, in page
// order, unique). The wrap's style is untrusted: only https URLs on Telegram's
// CDN hosts survive. The thumbnail of a quoted (replied-to) message is not
// this post's picture.
function photoUrls(wrap, $) {
  const urls = [];
  wrap.find(".tgme_widget_message_photo_wrap").each((_, element) => {
    if (urls.length >= MAX_IMAGE_URLS_PER_POST) return;
    if ($(element).closest(".tgme_widget_message_reply").length > 0) return;

    const style = String($(element).attr("style") || "").slice(0, MAX_STYLE_CHARS);
    const match = BACKGROUND_URL.exec(style);
    if (!match) return;

    const href = normalizeTelegramImageUrl((match[1] ?? match[2] ?? match[3] ?? "").trim());
    if (href && !urls.includes(href)) urls.push(href);
  });
  return urls;
}

// Parses the HTML of https://t.me/s/<username> into plain data. Uses a real
// HTML parser; posts are untrusted input and are never interpreted as markup.
export function parseChannelHtml(html, username) {
  const wanted = String(username).toLowerCase();
  const $ = cheerio.load(String(html));
  const posts = [];
  const seen = new Set();

  $(".tgme_widget_message_wrap").each((_, element) => {
    const wrap = $(element);

    const dataPost = wrap.find("[data-post]").first().attr("data-post") ?? wrap.attr("data-post");
    const match = typeof dataPost === "string" ? DATA_POST.exec(dataPost.trim()) : null;
    if (!match) return;

    const [, channel, idText] = match;
    if (channel.toLowerCase() !== wanted) return;

    const messageId = Number(idText);
    if (!Number.isSafeInteger(messageId) || messageId <= 0 || seen.has(messageId)) return;
    seen.add(messageId);

    const datetime = wrap.find("time[datetime]").first().attr("datetime");
    const parsedDate = datetime ? new Date(datetime) : null;
    const postedAt = parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate : null;

    // The post body; ignore the quoted text of a replied-to message.
    const textElement = wrap
      .find(".tgme_widget_message_text")
      .filter((__, candidate) => $(candidate).closest(".tgme_widget_message_reply").length === 0)
      .first();

    const links = [];
    const text = textElement.length ? normalizeText(nodeText(textElement.get(0), links)) : "";

    posts.push({
      messageId,
      postedAt,
      text,
      links: text ? links : [],
      hasImage: wrap.find(".tgme_widget_message_photo_wrap").length > 0,
      imageUrls: photoUrls(wrap, $),
    });
  });

  return posts;
}
