import rateLimit, { MemoryStore } from "express-rate-limit";

const rateLimitedHandler = (req, res) => {
  res.status(429).json({
    message: "Too many attempts. Please try again later.",
    error: "RATE_LIMITED",
  });
};

// Dedicated in-memory stores per limiter so tests can reset them independently
// of any other rate limiter (and so one endpoint's traffic doesn't count
// against the other's limit).
const loginStore = new MemoryStore();
const registerStore = new MemoryStore();

export const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 10, // 10 attempts per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  store: loginStore,
  handler: rateLimitedHandler,
});

export const registerRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: 10, // 10 registrations per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  store: registerStore,
  handler: rateLimitedHandler,
});

export const __resetAuthRateLimitStores = () => {
  loginStore.resetAll();
  registerStore.resetAll();
};
