import mongoose from "mongoose";
import Freelancer from "../models/freelancer.model.js";

export const loadFreelancer = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ message: "Freelancer not found." });
    }

    const freelancer = await Freelancer.findById(id);

    if (!freelancer) {
      return res.status(404).json({ message: "Freelancer not found." });
    }

    req.freelancer = freelancer;
    return next();
  } catch (error) {
    console.error(error);

    return res.status(500).json({ message: "Failed to load freelancer." });
  }
};

export const requireFreelancerOwner = (req, res, next) => {
  const isOwner = req.freelancer.user && req.freelancer.user.toString() === req.user._id.toString();
  const isAdmin = req.user.role === "admin";

  if (!isOwner && !isAdmin) {
    return res.status(403).json({
      message: "You do not have permission to modify this freelancer profile.",
    });
  }

  return next();
};

export default loadFreelancer;
