const WINDOW_MS_IP = 10 * 60 * 1000;
const WINDOW_MS_EMAIL = 30 * 60 * 1000;
const MAX_PER_IP = 15;
const MAX_PER_EMAIL = 5;

const ipStore = new Map();
const emailStore = new Map();

const now = () => Date.now();

const pruneStore = (store, windowMs) => {
  const cutoff = now() - windowMs;

  for (const [key, timestamps] of store.entries()) {
    const recent = timestamps.filter((ts) => ts >= cutoff);

    if (recent.length === 0) {
      store.delete(key);
    } else {
      store.set(key, recent);
    }
  }
};

const checkLimit = (store, key, windowMs, max) => {
  const cutoff = now() - windowMs;
  const existing = store.get(key) || [];
  const recent = existing.filter((ts) => ts >= cutoff);

  if (recent.length >= max) {
    return false;
  }

  recent.push(now());
  store.set(key, recent);
  return true;
};

const resendVerificationThrottle = (req, res, next) => {
  pruneStore(ipStore, WINDOW_MS_IP);
  pruneStore(emailStore, WINDOW_MS_EMAIL);

  const ipKey = String(req.ip || req.headers["x-forwarded-for"] || "unknown");
  const emailKey = String(req.body?.email || "").toLowerCase().trim();

  const ipAllowed = checkLimit(ipStore, ipKey, WINDOW_MS_IP, MAX_PER_IP);
  const emailAllowed = emailKey
    ? checkLimit(emailStore, emailKey, WINDOW_MS_EMAIL, MAX_PER_EMAIL)
    : true;

  if (!ipAllowed || !emailAllowed) {
    return res.status(429).json({
      message: "Too many resend attempts. Please try again later.",
      error: "RATE_LIMITED",
    });
  }

  return next();
};

export const __resetResendThrottleStores = () => {
  ipStore.clear();
  emailStore.clear();
};

export default resendVerificationThrottle;
