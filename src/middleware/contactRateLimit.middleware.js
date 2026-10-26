import rateLimit, { MemoryStore } from "express-rate-limit";
import { CONTACT_RATE_LIMITS } from "../utils/contact.utils.js";

const rateLimitedBody = {
  message: "Too many attempts. Please try again later.",
  error: "RATE_LIMITED",
};

// Own store so tests can reset it without touching the auth limiters.
const contactIpStore = new MemoryStore();

// Per visitor IP (the app trusts TRUST_PROXY_HOPS proxies, so req.ip is the real
// visitor). Counts every request that reaches the route.
export const contactIpRateLimiter = rateLimit({
  windowMs: CONTACT_RATE_LIMITS.windowMs,
  limit: CONTACT_RATE_LIMITS.perIp,
  standardHeaders: true,
  legacyHeaders: false,
  store: contactIpStore,
  handler: (req, res) => res.status(429).json(rateLimitedBody),
});

// Per email address, in memory (like resendVerificationThrottle: per process, lost
// on restart). Called by the controller once the email has been validated and
// normalised, so the key is never raw input. Returns true when the message may go on.
const emailHits = new Map();

export const allowContactEmail = (email, now = Date.now()) => {
  const cutoff = now - CONTACT_RATE_LIMITS.windowMs;

  for (const [key, timestamps] of emailHits.entries()) {
    const recent = timestamps.filter((ts) => ts >= cutoff);
    if (recent.length === 0) emailHits.delete(key);
    else emailHits.set(key, recent);
  }

  const recent = emailHits.get(email) || [];

  if (recent.length >= CONTACT_RATE_LIMITS.perEmail) return false;

  recent.push(now);
  emailHits.set(email, recent);
  return true;
};

export const contactRateLimitedResponse = (res) => res.status(429).json(rateLimitedBody);

export const __resetContactRateLimitStores = () => {
  contactIpStore.resetAll();
  emailHits.clear();
};
