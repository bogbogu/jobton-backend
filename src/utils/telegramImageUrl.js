// Allow-list for the photo URLs found in Telegram's public preview HTML.
//
// The HTML is untrusted: a URL that is fetched server-side (SSRF) or shown to
// an admin must be one of Telegram's own CDN hosts, over https, with no
// credentials and no custom port. Everything else is rejected, never repaired.

export const MAX_IMAGE_URL_CHARS = 2048;
export const MAX_IMAGE_URLS_PER_POST = 3;

// cdn1.cdn-telegram.org, cdn4.telesco.pe, ... The pattern is applied to the
// hostname AFTER the URL parser lowercased it, so "CDN1.TELESCO.PE" is the
// same host; lookalikes (cdn1.telesco.pe.evil.com), IP hosts and a trailing
// dot never match. No nested quantifiers: linear.
const ALLOWED_HOST = /^cdn\d*\.(cdn-telegram\.org|telesco\.pe)$/i;

// Whitespace and control characters never belong in a URL we would fetch.
const FORBIDDEN_CHARS = /[\x00-\x20\x7f-\x9f]/;

// Returns the normalized href of an allowed URL, or null.
export function normalizeTelegramImageUrl(value) {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > MAX_IMAGE_URL_CHARS) return null;
  if (FORBIDDEN_CHARS.test(value)) return null;

  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.port !== "") return null; // the parser drops an explicit :443; anything else stays
  if (!ALLOWED_HOST.test(url.hostname)) return null;

  const href = url.href;
  return href.length <= MAX_IMAGE_URL_CHARS ? href : null;
}

export const isAllowedTelegramImageUrl = (value) => normalizeTelegramImageUrl(value) !== null;

// Keeps the allowed URLs (normalized, unique), at most `max`. Anything that is
// not an array yields [].
export function filterAllowedImageUrls(values, max = MAX_IMAGE_URLS_PER_POST) {
  if (!Array.isArray(values)) return [];
  const out = [];
  for (const value of values) {
    const href = normalizeTelegramImageUrl(value);
    if (href && !out.includes(href)) out.push(href);
    if (out.length >= max) break;
  }
  return out;
}
