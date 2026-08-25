import express from "express";

import {
  registerUser,
  loginUser,
  getCurrentUser,
  verifyEmail,
  resendVerificationEmail,
  forgotPassword,
  resetPassword,
} from "../controllers/auth.controller.js";

import protect from "../middleware/auth.middleware.js";
import resendVerificationThrottle from "../middleware/resendVerificationThrottle.middleware.js";
import {
  loginRateLimiter,
  registerRateLimiter,
} from "../middleware/authRateLimit.middleware.js";

const router = express.Router();

router.post("/register", registerRateLimiter, registerUser);

router.post("/login", loginRateLimiter, loginUser);

router.post("/verify-email", verifyEmail);

router.post("/resend-verification", resendVerificationThrottle, resendVerificationEmail);

router.post("/forgot-password", forgotPassword);

router.post("/reset-password", resetPassword);

router.get("/me", protect, getCurrentUser);

export default router;