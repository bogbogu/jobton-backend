import mongoose from "mongoose";
import Job from "../models/job.model.js";
import { isPublishedJob } from "../utils/jobVisibility.js";

// Must run after `protect` (needs req.user). A job that is not published is
// loadable only by an admin or its owner; everyone else gets the same 404 as
// for a job that does not exist.
export const loadJob = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ message: "Job not found." });
    }

    const job = await Job.findById(id);

    if (!job) {
      return res.status(404).json({ message: "Job not found." });
    }

    if (!isPublishedJob(job)) {
      const isOwner = Boolean(job.postedBy) && Boolean(req.user) && job.postedBy.toString() === req.user._id.toString();
      const isAdmin = req.user?.role === "admin";

      if (!isOwner && !isAdmin) {
        return res.status(404).json({ message: "Job not found." });
      }
    }

    req.job = job;
    return next();
  } catch (error) {
    console.error(error);

    return res.status(500).json({ message: "Failed to load job." });
  }
};

// Used ONLY by DELETE /:id/save: a user must be able to remove a since-hidden
// job from their own saved list. It only deletes the caller's own SavedJob row
// and exposes nothing about the job.
export const loadJobForUnsave = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ message: "Job not found." });
    }

    const job = await Job.findById(id).select("_id");

    if (!job) {
      return res.status(404).json({ message: "Job not found." });
    }

    req.job = job;
    return next();
  } catch (error) {
    console.error(error);

    return res.status(500).json({ message: "Failed to load job." });
  }
};

export const requireJobOwner = (req, res, next) => {
  const isOwner = req.job.postedBy && req.job.postedBy.toString() === req.user._id.toString();
  const isAdmin = req.user.role === "admin";

  if (!isOwner && !isAdmin) {
    return res.status(403).json({
      message: "You do not have permission to modify this job.",
    });
  }

  return next();
};

export default loadJob;
