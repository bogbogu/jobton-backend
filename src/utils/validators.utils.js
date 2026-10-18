import validator from "validator";

// Shared input-safety helpers. Used by the Job/Company models (so every write
// path is covered, not just ingestion) and by the Telegram ingestion pipeline.

const MAX_URL_LENGTH = 2048;

// Whitespace, C0/C1 control characters, zero-width and bidi-override
// characters. None of them belong in a URL.
// eslint-disable-next-line no-control-regex
const URL_FORBIDDEN_CHARS = /[\u0000- \u007f-\u009f​-‏‪-‮⁦-⁩﻿]/;

// Control chars (except \n and \t), zero-width and bidi-override characters.
// eslint-disable-next-line no-control-regex
const TEXT_FORBIDDEN_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;

const HTML_TAG = /<\/?[a-zA-Z!][^>]*>/g;

// Only plain http(s) URLs to a real host. Rejects javascript:, data:,
// vbscript:, mailto:, protocol-relative ("//host"), credentials in the URL,
// whitespace/control characters, IP-literal hosts and single-label hosts.
export const isSafeHttpUrl = (value) => {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_LENGTH) {
    return false;
  }

  if (URL_FORBIDDEN_CHARS.test(value)) {
    return false;
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  if (!url.hostname || !url.hostname.includes(".")) return false;
  if (validator.isIP(url.hostname.replace(/^\[|\]$/g, ""))) return false;

  return true;
};

// Empty is allowed (field not set). Otherwise a plain hostname, e.g. "flutterwave.com".
export const isValidDomain = (value) => {
  if (value === undefined || value === null || value === "") return true;
  return typeof value === "string" && value.length <= 253 && validator.isFQDN(value);
};

export const isValidEmail = (value) =>
  typeof value === "string" && value.length <= 254 && validator.isEmail(value);

// Returns a normalized phone ("+2348012345678" style) or null when the value
// is not a plausible phone number. Nigerian local format (0801 234 5678) is
// converted to +234. Keeps digits and an optional leading "+".
export const normalizePhone = (raw) => {
  if (typeof raw !== "string") return null;

  const hasPlus = raw.trim().startsWith("+");
  const digits = raw.replace(/\D/g, "");

  if (!digits) return null;

  let normalized;
  if (hasPlus) {
    normalized = `+${digits}`;
  } else if (digits.length === 11 && digits.startsWith("0") && "789".includes(digits[1])) {
    normalized = `+234${digits.slice(1)}`;
  } else if (digits.length === 13 && digits.startsWith("234")) {
    normalized = `+${digits}`;
  } else {
    normalized = digits;
  }

  const digitCount = normalized.replace(/\D/g, "").length;
  return digitCount >= 7 && digitCount <= 15 ? normalized : null;
};

// Validator form: a stored phone must already be in normalized form.
export const isValidStoredPhone = (value) =>
  value === undefined || value === null || value === "" || normalizePhone(value) === value;

// Plain-text hygiene for fields rendered by the frontend: strips HTML tags,
// control characters, zero-width and bidi-override characters. The frontend
// renders these as text, but this keeps stored data clean as defense in depth.
export const cleanText = (value) => {
  if (typeof value !== "string") return value;
  return value.replace(HTML_TAG, "").replace(TEXT_FORBIDDEN_CHARS, "").trim();
};

const TRACKING_PARAM = /^(utm_.*|_ga.*|_gl|fbclid|gclid|mc_.*|igshid|ref|source|trk)$/i;

// Removes analytics/tracking query parameters. Returns the input unchanged
// if it is not a parseable URL.
export const stripTrackingParams = (raw) => {
  try {
    const url = new URL(raw);
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return raw;
  }
};

export const LINK_CLASSES = [
  "ats",
  "company_domain",
  "form",
  "social_or_short",
  "other_domain",
  "none",
];

const ATS_HOSTS =
  /(^|\.)(workable\.com|greenhouse\.io|lever\.co|ashbyhq\.com|smartrecruiters\.com|recruitee\.com|bamboohr\.com|breezy\.hr|teamtailor\.com|personio\.(de|com)|jobvite\.com|myworkdayjobs\.com|icims\.com|zohorecruit\.com|taleo\.net|pinpointhq\.com|applytojob\.com|jazz\.co)$/i;
const FORM_URL =
  /(docs\.google\.com\/forms|forms\.gle|typeform\.com|jotform\.com|airtable\.com|forms\.office\.com|forms\.zohopublic|tally\.so|paperform\.co)/i;
const SOCIAL_HOSTS =
  /(^|\.)(linkedin\.com|wa\.me|whatsapp\.com|t\.me|instagram\.com|facebook\.com|twitter\.com|x\.com|bit\.ly|tinyurl\.com|linktr\.ee|cutt\.ly|rb\.gy|shorturl\.at)$/i;

// Classifies where an apply link points, from the URL STRING only (never
// fetches it). A verification SIGNAL, not a verdict:
//   ats            real posting on a known applicant-tracking system (strong)
//   company_domain domain contains the company name (probably employer's site)
//   form           anonymous form, cannot tell who runs it (weak)
//   social_or_short chat/social/shortened link (weak)
//   other_domain   some other site (needs a human look)
//   none           no link
export const classifyLink = (url, company) => {
  if (!url || !isSafeHttpUrl(url)) return "none";

  const clean = stripTrackingParams(url);
  if (FORM_URL.test(clean)) return "form";

  const host = new URL(clean).hostname.toLowerCase();
  if (ATS_HOSTS.test(host)) return "ats";
  if (SOCIAL_HOSTS.test(host)) return "social_or_short";

  if (company) {
    const token = company
      .toLowerCase()
      .replace(/\b(ltd|limited|plc|inc|group|technologies|nigeria|the|co)\b/g, "")
      .replace(/[^a-z0-9]/g, "");
    if (token.length >= 3 && host.replace(/[^a-z0-9]/g, "").includes(token)) {
      return "company_domain";
    }
  }

  return "other_domain";
};
