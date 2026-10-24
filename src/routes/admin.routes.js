import express from "express";
import {
  listAdminJobs,
  getAdminJob,
  approveJob,
  rejectJob,
  bulkRejectJobs,
} from "../controllers/adminJob.controller.js";
import {
  listChannels,
  createChannel,
  updateChannel,
} from "../controllers/adminChannel.controller.js";
import protect, { requireAdmin } from "../middleware/auth.middleware.js";

const router = express.Router();

// Every admin route requires a valid token AND an admin role (read from the DB).
router.use(protect, requireAdmin);

router.get("/jobs", listAdminJobs);
// Registered before the '/jobs/:id' routes so "bulk-reject" is never read as an id.
router.post("/jobs/bulk-reject", bulkRejectJobs);
router.get("/jobs/:id", getAdminJob);
router.post("/jobs/:id/approve", approveJob);
router.post("/jobs/:id/reject", rejectJob);

router.get("/telegram-channels", listChannels);
router.post("/telegram-channels", createChannel);
router.patch("/telegram-channels/:id", updateChannel);

export default router;
