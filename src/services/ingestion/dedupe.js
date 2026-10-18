import { createHash } from "node:crypto";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// Lowercase, strip accents, drop everything except letters/digits, collapse
// whitespace. Emoji, punctuation and spacing differences between reposts of
// the same text do not change the result.
export const normalizeForHash = (value) =>
  String(value ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

export function hashPostText(text) {
  return sha256(normalizeForHash(text));
}

// Identity of a vacancy across reposts: title|company|location. A job without
// a company is too ambiguous on those alone, so the start of its description
// is mixed in.
export function computeDedupeKey({ title, company, location, description } = {}) {
  const parts = [normalizeForHash(title), normalizeForHash(company), normalizeForHash(location)];
  if (!parts[1]) {
    parts.push(normalizeForHash(description).slice(0, 200));
  }
  return sha256(parts.join("|"));
}
