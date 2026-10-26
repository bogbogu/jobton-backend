import validator from "validator";
import { cleanText } from "./validators.utils.js";

// Public contact form. These numbers are shown by the frontend as well: change
// them here only, the model, the validation, the docs and the tests all read them.
export const CONTACT_LIMITS = {
  nameMax: 80,
  emailMax: 254,
  subjectMax: 120,
  messageMax: 2000,
};

// Requests per visitor IP, and messages per email address, in each window.
export const CONTACT_RATE_LIMITS = {
  windowMs: 60 * 60 * 1000, // 1 hour
  perIp: 5,
  perEmail: 3,
};

// A saved copy is deleted after this long (data minimisation).
export const CONTACT_RETENTION_DAYS = 90;
export const CONTACT_RETENTION_SECONDS = CONTACT_RETENTION_DAYS * 24 * 60 * 60;

// Across ALL visitors: once this many messages were saved in the last hour, new
// ones are still saved but no email is sent (protects the shared Resend quota that
// verification and password-reset emails also use).
export const CONTACT_GLOBAL_PER_HOUR = 60;
export const CONTACT_GLOBAL_WINDOW_MS = 60 * 60 * 1000;

// Name of the hidden honeypot input. Not "website": browsers and password managers autofill that.
export const CONTACT_HONEYPOT_FIELD = "reference_code";

export const CONTACT_EMAIL_STATUSES = ["sent", "failed", "skipped"];

// Where messages go when CONTACT_INBOX_EMAIL is unset or not a valid address.
export const DEFAULT_CONTACT_INBOX = "info@jobton.com.ng";

// Hard cap on the raw text before cleaning. cleanText itself only looks at the
// first 20,000 characters, so anything longer is refused rather than silently cut.
const RAW_INPUT_MAX = 20000;

// Fixed, short messages. Never built from what the visitor typed.
export const CONTACT_FIELD_MESSAGES = {
  name: {
    required: "Name is required.",
    tooLong: `Name must be at most ${CONTACT_LIMITS.nameMax} characters.`,
  },
  email: {
    required: "Email is required.",
    invalid: "Please provide a valid email address.",
    tooLong: `Email must be at most ${CONTACT_LIMITS.emailMax} characters.`,
  },
  subject: {
    required: "Subject is required.",
    tooLong: `Subject must be at most ${CONTACT_LIMITS.subjectMax} characters.`,
  },
  message: {
    required: "Message is required.",
    tooLong: `Message must be at most ${CONTACT_LIMITS.messageMax} characters.`,
  },
};

// Control characters, line/paragraph separators, soft hyphen and zero-width /
// bidi / invisible-format characters. In a single-line field none of them is
// legitimate, and CR/LF in particular would allow email-header injection.
const SINGLE_LINE_FORBIDDEN =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g;

// For name and subject: tabs and line breaks become a space, every other control
// character is dropped, then whitespace is collapsed and trimmed.
export const cleanSingleLine = (value) => {
  if (typeof value !== "string") return value;

  return value
    .slice(0, RAW_INPUT_MAX)
    .replace(/[\t\r\n\u2028\u2029]+/g, " ")
    .replace(SINGLE_LINE_FORBIDDEN, "")
    .replace(/\s+/g, " ")
    .trim();
};

// For the message: plain text. Line breaks are kept (CRLF and a lone CR become
// \n), tabs become a space, control characters and HTML tags are removed.
export const cleanMessage = (value) => {
  if (typeof value !== "string") return value;

  return cleanText(value.slice(0, RAW_INPUT_MAX).replace(/\r\n?/g, "\n").replace(/\t/g, " "));
};

// Characters that have no place in a plain address and could change how a
// Reply-To header is read (display-name and group syntax, quoting, comments).
const EMAIL_FORBIDDEN = /[\s<>()[\]\\,;:"]/;

// Printable ASCII only (! to ~): refuses bidi/zero-width/soft-hyphen characters,
// non-ASCII local parts and internationalised domains.
const PRINTABLE_ASCII = /^[!-~]+$/;

export const isContactEmail = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= CONTACT_LIMITS.emailMax &&
  PRINTABLE_ASCII.test(value) &&
  !EMAIL_FORBIDDEN.test(value) &&
  validator.isEmail(value, { allow_utf8_local_part: false });

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// The hidden honeypot field (reference_code) is empty for a person. Anything else is the trap.
export const isHoneypotFilled = (body) => {
  if (!isPlainObject(body)) return false;

  const value = body[CONTACT_HONEYPOT_FIELD];
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim() !== "";

  return true;
};

// Returns { ok: false, reason: "INVALID_INPUT" },
// { ok: false, reason: "VALIDATION_ERROR", fields }
// or { ok: true, value: { name, email, subject, message } }.
export const validateContactInput = (body) => {
  if (!isPlainObject(body)) return { ok: false, reason: "INVALID_INPUT" };

  // A JSON body can carry numbers, objects or arrays: only plain strings are
  // accepted. A field that is simply absent is a normal "required" error below.
  const values = [body.name, body.email, body.subject, body.message];

  if (!values.every((value) => value === undefined || typeof value === "string")) {
    return { ok: false, reason: "INVALID_INPUT" };
  }

  const name = body.name ?? "";
  const email = body.email ?? "";
  const subject = body.subject ?? "";
  const message = body.message ?? "";

  const fields = {};
  const cleaned = {
    // null marks a value too long to even clean (refused, never silently cut).
    name: name.length > RAW_INPUT_MAX ? null : cleanSingleLine(name),
    email: email.trim().toLowerCase(),
    subject: subject.length > RAW_INPUT_MAX ? null : cleanSingleLine(subject),
    message: message.length > RAW_INPUT_MAX ? null : cleanMessage(message),
  };

  if (cleaned.name === null) fields.name = CONTACT_FIELD_MESSAGES.name.tooLong;
  else if (!cleaned.name) fields.name = CONTACT_FIELD_MESSAGES.name.required;
  else if (cleaned.name.length > CONTACT_LIMITS.nameMax) fields.name = CONTACT_FIELD_MESSAGES.name.tooLong;

  if (!cleaned.email) fields.email = CONTACT_FIELD_MESSAGES.email.required;
  else if (cleaned.email.length > CONTACT_LIMITS.emailMax) fields.email = CONTACT_FIELD_MESSAGES.email.tooLong;
  else if (!isContactEmail(cleaned.email)) fields.email = CONTACT_FIELD_MESSAGES.email.invalid;

  if (cleaned.subject === null) fields.subject = CONTACT_FIELD_MESSAGES.subject.tooLong;
  else if (!cleaned.subject) fields.subject = CONTACT_FIELD_MESSAGES.subject.required;
  else if (cleaned.subject.length > CONTACT_LIMITS.subjectMax) {
    fields.subject = CONTACT_FIELD_MESSAGES.subject.tooLong;
  }

  if (cleaned.message === null) fields.message = CONTACT_FIELD_MESSAGES.message.tooLong;
  else if (!cleaned.message) fields.message = CONTACT_FIELD_MESSAGES.message.required;
  else if (cleaned.message.length > CONTACT_LIMITS.messageMax) {
    fields.message = CONTACT_FIELD_MESSAGES.message.tooLong;
  }

  if (Object.keys(fields).length > 0) return { ok: false, reason: "VALIDATION_ERROR", fields };

  return { ok: true, value: cleaned };
};
