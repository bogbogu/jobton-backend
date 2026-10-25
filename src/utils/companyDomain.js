import { FREE_MAIL_DOMAINS } from "../services/ingestion/redFlags.js";
import {
  hostMatchesCompany,
  isSafeHttpUrl,
  isValidDomain,
  isValidEmail,
  registrableDomain,
} from "./validators.utils.js";

// Hosts that say nothing about WHO the employer is: messaging and social
// links, link shorteners, form builders, job boards and applicant-tracking
// systems (they host many employers), plus big shared platforms. A logo for
// one of these would be the platform's, not the company's. A blocked host also
// blocks all of its subdomains (acme.workable.com).
const SHARED_HOSTS = [
  // messaging / social
  "t.me",
  "telegram.me",
  "telegram.org",
  "wa.me",
  "whatsapp.com",
  "linkedin.com",
  "lnkd.in",
  "facebook.com",
  "fb.me",
  "instagram.com",
  "twitter.com",
  "x.com",
  "tiktok.com",
  "youtube.com",
  // job boards
  "indeed.com",
  "jobberman.com",
  "myjobmag.com",
  "glassdoor.com",
  "ziprecruiter.com",
  "wellfound.com",
  // google (forms, docs, shorteners)
  "google.com",
  "forms.gle",
  "docs.google.com",
  "goo.gl",
  // link shorteners
  "bit.ly",
  "tinyurl.com",
  "ow.ly",
  "t.co",
  "rebrand.ly",
  // applicant-tracking systems
  "workable.com",
  "greenhouse.io",
  "lever.co",
  "smartrecruiters.com",
  "ashbyhq.com",
  "breezy.hr",
  "recruitee.com",
  "bamboohr.com",
  "jobvite.com",
  "myworkdayjobs.com",
  // forms / docs / link-in-bio
  "typeform.com",
  "airtable.com",
  "notion.so",
  "notion.site",
  "linktr.ee",
  "cutt.ly",
  "rb.gy",
  "shorturl.at",
  "is.gd",
  "wa.link",
  "fb.com",
  // free site/app hosting: the host names the platform, not the employer
  "github.io",
  "vercel.app",
  "netlify.app",
  "herokuapp.com",
  "wixsite.com",
  "wordpress.com",
  "blogspot.com",
  "weebly.com",
  "webflow.io",
  "pages.dev",
  "forms.office.com",
  "microsoft.com",
  "jotform.com",
  "tally.so",
];

const BLOCKED_HOSTS = new Set([...SHARED_HOSTS, ...FREE_MAIL_DOMAINS]);

// Public suffixes are not anyone's domain, and these endings are never public
// company hosts.
const PUBLIC_SUFFIXES = new Set(["co.uk", "com.ng", "org.ng", "gov.ng", "edu.ng"]);
const NON_PUBLIC_ENDINGS = ["local", "internal", "test", "localhost", "example", "invalid"];

const isNonPublicName = (host) =>
  PUBLIC_SUFFIXES.has(host) || NON_PUBLIC_ENDINGS.some((ending) => host === ending || host.endsWith(`.${ending}`));

// True for a blocked host and for any subdomain of one.
const isBlockedHost = (host) => {
  const labels = host.split(".");
  for (let start = 0; start < labels.length - 1; start += 1) {
    if (BLOCKED_HOSTS.has(labels.slice(start).join("."))) return true;
  }
  return false;
};

// Normalizes a candidate hostname and returns it only when it is a plain,
// lowercase hostname that is not a shared/generic host. Internationalized names
// (punycode, "xn--") are refused: a look-alike of a real company's name must
// never inherit that company's logo.
const usableDomain = (value) => {
  if (typeof value !== "string") return null;

  let host = value.trim().toLowerCase();
  while (host.endsWith(".")) host = host.slice(0, -1);
  host = host.replace(/^www\./, "");

  if (!host || !host.includes(".")) return null;
  if (host.split(".").some((label) => label.startsWith("xn--"))) return null;
  // The same check the Job model applies to its `domain` field.
  if (!isValidDomain(host)) return null;
  if (isNonPublicName(host)) return null;
  if (isBlockedHost(host)) return null;

  return host;
};

const domainFromLink = (link) => {
  if (typeof link !== "string") return null;
  const trimmed = link.trim();

  // isSafeHttpUrl rejects javascript:/data: schemes, credentials in the URL,
  // IP hosts and control/invisible characters.
  if (!isSafeHttpUrl(trimmed)) return null;

  try {
    // `hostname` carries no port, no userinfo and no path.
    return usableDomain(new URL(trimmed).hostname);
  } catch {
    return null;
  }
};

const domainFromEmail = (email) => {
  if (typeof email !== "string") return null;
  const candidate = email.trim().toLowerCase();
  if (!isValidEmail(candidate)) return null;
  return usableDomain(candidate.slice(candidate.lastIndexOf("@") + 1));
};

// The employer's own domain for a job, taken from how to apply. null when
// nothing points at the employer (shared hosts, free mail, malformed input).
// Used only to fill an EMPTY `domain`; it never replaces one a person or the
// model already set.
//
// A post can carry any link, so a link's host is only trusted when something
// else vouches for it:
//   - the host's main label is the company's name (acme.com for "Acme Ltd"), or
//   - the apply email is on the same registrable domain as the link.
// A link nothing vouches for gives null, even when an email is present (the two
// disagree, so neither is trusted). Without a usable link, the apply email's
// own domain is used (free-mail and blocked providers excluded).
export function deriveCompanyDomain({ applicationLink, applyEmail, company } = {}) {
  const linkHost = domainFromLink(applicationLink);
  const emailHost = domainFromEmail(applyEmail);

  if (!linkHost) return emailHost;

  if (hostMatchesCompany(linkHost, company)) return linkHost;

  if (emailHost) {
    const linkSite = registrableDomain(linkHost);
    if (linkSite && linkSite === registrableDomain(emailHost)) return linkHost;
  }

  return null;
}
