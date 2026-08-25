import mongoose from "mongoose";
import Job from "../models/job.model.js";

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
