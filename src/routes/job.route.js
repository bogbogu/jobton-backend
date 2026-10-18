import express from "express";
import {
  getJobs,
  getJobById,
  createJob,
  updateJob,
  deleteJob,
  getSavedJobs,
  saveJob,
  unsaveJob,
} from "../controllers/job.controller.js";
import protect, { optionalAuth } from "../middleware/auth.middleware.js";
import { loadJob, loadJobForUnsave, requireJobOwner } from "../middleware/job.middleware.js";

const router = express.Router();

// Must come before GET /:id — otherwise Express matches "saved" as the :id
// param and this route is never reached.
router.get("/saved", protect, getSavedJobs);

router.get("/", optionalAuth, getJobs);
router.get("/:id", optionalAuth, getJobById);

router.post("/", protect, createJob);
router.post("/:id/save", protect, loadJob, saveJob);
router.delete("/:id/save", protect, loadJobForUnsave, unsaveJob);
router.patch("/:id", protect, loadJob, requireJobOwner, updateJob);
router.delete("/:id", protect, loadJob, requireJobOwner, deleteJob);

export default router;
