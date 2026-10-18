import * as cheerio from "cheerio";
import { cleanText, isSafeHttpUrl } from "../../utils/validators.utils.js";

const MAX_TEXT_CHARS = 4000;
const MAX_LINKS = 10;
const MAX_LABEL_CHARS = 300;
const DATA_POST = /^([A-Za-z0-9_]+)\/(\d+)$/;

const SKIPPED_TAGS = new Set(["script", "style", "template", "noscript"]);

// "https://example.com/" and "example.com" are the same destination for the
// purpose of deciding whether a link label needs to be repeated next to it.
const looseUrl = (value) =>
  String(value)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");

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

function normalizeText(raw) {
  const tidy = String(raw)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
  return cleanText(tidy).slice(0, MAX_TEXT_CHARS).trim();
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
    });
  });

  return posts;
}
