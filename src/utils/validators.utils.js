import validator from "validator";

// Shared input-safety helpers. Used by the Job/Company models (so every write
// path is covered, not just ingestion) and by the Telegram ingestion pipeline.
//
// Every regex here runs on untrusted input: keep them linear (no nested or
// overlapping quantifiers) and cap the input length before running them.

const MAX_URL_LENGTH = 2048;

// Hard cap on what cleanText will look at. Above every field's maxlength, so
// oversize input still fails the Mongoose maxlength validator afterwards.
const MAX_CLEAN_TEXT_INPUT = 20000;

// Whitespace (incl. NBSP, U+2028/2029, U+3000), C0/C1 control characters,
// soft hyphen, and zero-width / bidi / invisible-format characters. None of
// them belong in a URL.
const URL_FORBIDDEN_CHARS =
  // eslint-disable-next-line no-control-regex
  /[\s\u0000-\u0020\u007f-\u009f\u00a0\u00ad\u061c\u180e\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u206f\u3000\ufeff\ufff9-\ufffb]/;

// Control chars (except \n and \t), zero-width, bidi and invisible-format
// characters.
const TEXT_FORBIDDEN_CHARS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g;

// A tag cannot contain "<" or ">": each "<" scans at most to the next "<",
// so the whole pass is linear (the old "[^>]*" form was quadratic on "<a<a<a...").
const ANGLE_BRACKETS = /[<>]/g;

const HTML_TAG = /<\/?[a-zA-Z!][^<>]*>/g;

// Only plain http(s) URLs to a real host. Rejects javascript:, data:,
// vbscript:, mailto:, protocol-relative ("//host"), "https:evil.com" (no
// slashes), credentials in the URL, whitespace/control/invisible characters,
// IP-literal hosts and single-label hosts.
export const isSafeHttpUrl = (value) => {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_LENGTH) {
    return false;
  }

  if (!/^https?:\/\//i.test(value)) return false;

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

const EMAIL_LOCAL_PART = /^[A-Za-z0-9._%+-]+$/;
const EMAIL_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const EMAIL_TLD = /^[A-Za-z]{2,63}$/;

// Conservative ASCII-only email: local part [A-Za-z0-9._%+-], ASCII hostname
// with a TLD (no IP domains, no quoted/UTF-8 local parts). Rejects values that
// could smuggle mailto: parameters ("a?bcc=x@y.com") or bidi/format characters.
export const isValidEmail = (value) => {
  if (typeof value !== "string" || value.length === 0 || value.length > 254) return false;

  const parts = value.split("@");
  if (parts.length !== 2) return false;
  const [local, domain] = parts;

  if (local.length === 0 || local.length > 64 || !EMAIL_LOCAL_PART.test(local)) return false;

  const labels = domain.split(".");
  if (labels.length < 2) return false;
  if (!EMAIL_TLD.test(labels[labels.length - 1])) return false;
  for (const label of labels) {
    if (label.length > 63 || !EMAIL_LABEL.test(label)) return false;
  }

  return validator.isEmail(value, { allow_utf8_local_part: false, allow_ip_domain: false });
};

// Returns a normalized phone ("+2348012345678" style) or null when the value
// is not a plausible phone number. Nigerian local format (0801 234 5678) is
// converted to +234. Keeps digits and an optional leading "+".
export const normalizePhone = (raw) => {
  if (typeof raw !== "string") return null;

  // Only digits, an optional +, and ordinary separators (spaces, dots, dashes,
  // parentheses) are allowed. Anything else (letters such as "ext 12", ";", "x")
  // rejects the value: stripping it would silently glue digits into a different number.
  if (raw.length > 40 || !/^[+\d \t().-]+$/.test(raw)) return null;

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
// Only the first MAX_CLEAN_TEXT_INPUT characters are looked at.
//
// Idempotent: removing a tag (or an invisible character) can join the pieces
// around it into a NEW tag ("<<b>script>" -> "<script>", "<[zero-width]script>" ->
// "<script>"), so the pass repeats until the text stops changing (at most
// MAX_CLEAN_PASSES). If any pass changed something, leftover "<" and ">" are
// removed too; text that needed no cleaning keeps its "<" / ">" ("x < y").
const MAX_CLEAN_PASSES = 5;

export const cleanText = (value) => {
  if (typeof value !== "string") return value;

  let text = value.slice(0, MAX_CLEAN_TEXT_INPUT);
  let changed = false;

  for (let pass = 0; pass < MAX_CLEAN_PASSES; pass += 1) {
    const next = text.replace(HTML_TAG, "").replace(TEXT_FORBIDDEN_CHARS, "");
    if (next === text) break;
    text = next;
    changed = true;
  }

  if (changed) text = text.replace(ANGLE_BRACKETS, "");

  return text.trim();
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
// Hosts that are only form builders (matched against the host, never the
// whole URL string).
const FORM_HOSTS =
  /(^|\.)(forms\.gle|typeform\.com|jotform\.com|airtable\.com|forms\.office\.com|tally\.so|paperform\.co)$/i;
const SOCIAL_HOSTS =
  /(^|\.)(linkedin\.com|wa\.me|whatsapp\.com|t\.me|instagram\.com|facebook\.com|twitter\.com|x\.com|bit\.ly|tinyurl\.com|linktr\.ee|cutt\.ly|rb\.gy|shorturl\.at)$/i;

const isFormUrl = (host, pathname) => {
  if (FORM_HOSTS.test(host)) return true;
  if (host.startsWith("forms.zohopublic.")) return true;
  return host === "docs.google.com" && pathname.toLowerCase().startsWith("/forms");
};

// Second-level labels that, together with a 2-letter ccTLD (acme.co.uk,
// acme.com.ng), form the public suffix.
const SECOND_LEVEL_LABELS = new Set(["co", "com", "org", "net", "gov", "edu", "ac", "sch"]);
const COMPANY_HOST_SUFFIXES = ["careers", "jobs", "hr", "recruit", "recruitment"];

// The "main" label of the registrable domain: acme in careers.acme.com and in
// acme.co.uk. Null when the host has no registrable domain (e.g. "co.uk").
// The registrable domain of a host: careers.acme.com -> acme.com,
// jobs.acme.co.uk -> acme.co.uk. Null when the host has none (e.g. "co.uk").
export const registrableDomain = (host) => {
  const labels = String(host).split(".");
  if (labels.length < 2) return null;
  const last = labels[labels.length - 1];
  const second = labels[labels.length - 2];
  const suffixLabels = labels.length >= 3 && last.length === 2 && SECOND_LEVEL_LABELS.has(second) ? 2 : 1;
  const index = labels.length - 1 - suffixLabels;
  return index >= 0 ? labels.slice(index).join(".") : null;
};

const mainDomainLabel = (host) => registrableDomain(host)?.split(".")[0] ?? null;

const companyToken = (company) =>
  String(company)
    .toLowerCase()
    .replace(/\b(ltd|limited|plc|inc|group|technologies|nigeria|the|co)\b/g, "")
    .replace(/[^a-z0-9]/g, "");

// True when the host's main label is the company's name: "acme" or "acme-corp"
// for "Acme Corp"; "acmecareers"/"acmejobs"/... as written (hyphenated
// look-alikes such as "acme-jobs" do not qualify).
export const hostMatchesCompany = (host, company) => {
  if (!company) return false;
  const token = companyToken(company);
  const main = mainDomainLabel(host);
  if (token.length < 3 || !main) return false;
  return main.replace(/-/g, "") === token || COMPANY_HOST_SUFFIXES.some((suffix) => main === `${token}${suffix}`);
};

// Classifies where an apply link points, from the URL STRING only (never
// fetches it). A verification SIGNAL, not a verdict:
//   ats            real posting on a known applicant-tracking system (strong)
//   company_domain registrable domain IS the company name (probably employer's site)
//   form           anonymous form, cannot tell who runs it (weak)
//   social_or_short chat/social/shortened link (weak)
//   other_domain   some other site (needs a human look)
//   none           no link
export const classifyLink = (url, company) => {
  if (!url || !isSafeHttpUrl(url)) return "none";

  const parsed = new URL(stripTrackingParams(url));
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");

  if (isFormUrl(host, parsed.pathname)) return "form";
  if (ATS_HOSTS.test(host)) return "ats";
  if (SOCIAL_HOSTS.test(host)) return "social_or_short";

  if (hostMatchesCompany(host, company)) return "company_domain";

  return "other_domain";
};
