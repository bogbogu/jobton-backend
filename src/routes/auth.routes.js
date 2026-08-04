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

const router = express.Router();

router.post("/register", registerUser);

router.post("/login", loginUser);

router.post("/verify-email", verifyEmail);

router.post("/resend-verification", resendVerificationThrottle, resendVerificationEmail);

router.post("/forgot-password", forgotPassword);

router.post("/reset-password", resetPassword);

router.get("/me", protect, getCurrentUser);

export default router;