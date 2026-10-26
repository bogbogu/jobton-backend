import express from "express";
import { submitContactMessage } from "../controllers/contact.controller.js";
import { contactIpRateLimiter } from "../middleware/contactRateLimit.middleware.js";

const router = express.Router();

router.post("/", contactIpRateLimiter, submitContactMessage);

export default router;
