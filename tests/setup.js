process.env.NODE_ENV = "test";
// Hermetic: tests must not depend on a developer's private .env.
process.env.JWT_SECRET = process.env.JWT_SECRET || "test_jwt_secret_not_for_production";
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || "test_key";
process.env.RESEND_FROM_EMAIL =
  process.env.RESEND_FROM_EMAIL || "noreply@example.com";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";
