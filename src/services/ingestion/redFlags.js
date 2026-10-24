// Scam / quality signals computed in PLAIN CODE from the post text and the
// already-sanitized job. Nothing here comes from the LLM, so a model that has
// been talked into calling a scam "legitimate" cannot hide these. The strings
// are short and stable (the admin UI may key on them).

export const RED_FLAGS = Object.freeze({
  NO_EMPLOYER: "no_employer_named",
  NO_APPLY_METHOD: "no_apply_method",
  FORM_LINK: "apply_link_is_form",
  MESSAGING_OR_SHORT_LINK: "apply_link_is_messaging_or_shortened",
  MESSAGING_ONLY: "contact_only_via_whatsapp_or_telegram",
  FEE: "fee_or_payment_requested",
  SENSITIVE_DATA: "sensitive_data_requested",
  PUNYCODE: "punycode_host",
  FREE_MAIL: "free_mail_contact_for_named_company",
});

const FREE_MAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.uk",
  "ymail.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "msn.com",
  "aol.com",
  "icloud.com",
  "proton.me",
  "protonmail.com",
  "mail.com",
  "gmx.com",
  "zoho.com",
]);

// "no registration fee" / "free of charge" must not trigger the fee flag.
const FEE_NEGATION = /\b(no|without|zero|free\s+of|not\s+charge[sd]?)\s+(\w+\s+){0,2}(fees?|charges?)\b/gi;

const FEE_PATTERNS = [
  /\b(registration|application|processing|training|screening|interview|admin(istrative)?|verification|documentation|medical|clearance|onboarding|portal)\s+(fees?|charges?|payments?)\b/i,
  /\b(pay|paying|payment\s+of|make\s+a\s+payment\s+of)\s+(a\s+|an\s+|the\s+|your\s+|small\s+|refundable\s+)*(fees?|deposit|amount|charges?)\b/i,
  /\b(pay|paying|send|sending|transfer|transferring|make)\s+(a\s+|some\s+|the\s+|your\s+|small\s+|refundable\s+)*(deposit|money|funds?)\b/i,
  /\b(buy|purchase|pay\s+for)\s+(a\s+|the\s+|your\s+)?(form|application\s+form|scratch\s+card|pin|uniform|starter\s+kit|kit|laptop|equipment)\b/i,
  /\bpay\s+(₦|n|ngn)\s?\d/i,
  /\b(refundable|security|initial|upfront|caution)\s+(deposit|payment|fee)\b/i,
  /\bdeposit\s+(of|is|required|must)\b/i,
];

const SENSITIVE_PATTERNS = [
  /\bbank\s+(account\s+)?(details|information|info|statement)\b/i,
  /\baccount\s+(number|no\.?|details)\b/i,
  /\b(bvn|nin)\b/i,
  /\b(atm\s+(card|pin)|cvv|card\s+number|otp)\b/i,
  /\b(send|attach|submit|provide|share|upload)\b[^.\n]{0,40}\b(passport|photograph|photo)\b/i,
];

const MESSAGING_MENTION = /\b(whats\s?app|wa\.me|telegram|t\.me)\b/i;

const URL_IN_TEXT = /https?:\/\/[^\s<>"'()[\]]+/gi;

const hasPunycodeHost = (value) => {
  try {
    return new URL(value).hostname.split(".").some((label) => label.toLowerCase().startsWith("xn--"));
  } catch {
    return false;
  }
};

export function computeRedFlags({ job = {}, text = "", linkClass = "none" } = {}) {
  const flags = [];
  const body = String(text ?? "");
  const hasLink = Boolean(job.applicationLink);
  const hasEmail = Boolean(job.applyEmail);
  const hasPhone = Boolean(job.applyPhone);

  if (!job.company) flags.push(RED_FLAGS.NO_EMPLOYER);

  if (!hasLink && !hasEmail && !hasPhone) flags.push(RED_FLAGS.NO_APPLY_METHOD);

  if (linkClass === "form") flags.push(RED_FLAGS.FORM_LINK);
  if (linkClass === "social_or_short") flags.push(RED_FLAGS.MESSAGING_OR_SHORT_LINK);

  // No email and no real website to apply at, only chat apps / a phone number.
  const noWebOrEmail = !hasEmail && (!hasLink || linkClass === "social_or_short");
  if (noWebOrEmail && (hasLink || hasPhone) && MESSAGING_MENTION.test(`${body} ${job.applicationLink || ""}`)) {
    flags.push(RED_FLAGS.MESSAGING_ONLY);
  }

  const withoutNegations = body.replace(FEE_NEGATION, " ");
  if (FEE_PATTERNS.some((pattern) => pattern.test(withoutNegations))) flags.push(RED_FLAGS.FEE);

  if (SENSITIVE_PATTERNS.some((pattern) => pattern.test(body))) flags.push(RED_FLAGS.SENSITIVE_DATA);

  const urls = [job.applicationLink, ...(body.match(URL_IN_TEXT) || [])].filter(Boolean);
  if (urls.some(hasPunycodeHost)) flags.push(RED_FLAGS.PUNYCODE);

  if (hasEmail && job.company) {
    const domain = String(job.applyEmail).split("@").pop().toLowerCase();
    if (FREE_MAIL_DOMAINS.has(domain)) flags.push(RED_FLAGS.FREE_MAIL);
  }

  return flags;
}
