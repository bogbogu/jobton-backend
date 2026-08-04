process.env.NODE_ENV = "test";
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || "test_key";
process.env.RESEND_FROM_EMAIL =
  process.env.RESEND_FROM_EMAIL || "noreply@example.com";
process.env.RESEND_TO_EMAIL = process.env.RESEND_TO_EMAIL || "audit@example.com";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";
