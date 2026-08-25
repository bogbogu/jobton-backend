import express from "express";
import {
  getJobs,
  getJobById,
  createJob,
  updateJob,
  deleteJob,
} from "../controllers/job.controller.js";
import protect from "../middleware/auth.middleware.js";
import { loadJob, requireJobOwner } from "../middleware/job.middleware.js";

const router = express.Router();

router.get("/", getJobs);
router.get("/:id", getJobById);

router.post("/", protect, createJob);
router.patch("/:id", protect, loadJob, requireJobOwner, updateJob);
router.delete("/:id", protect, loadJob, requireJobOwner, deleteJob);

export default router;
