import express from "express";
import {
  getFreelancers,
  getFreelancerById,
  createFreelancer,
  updateFreelancer,
  deleteFreelancer,
} from "../controllers/freelancer.controller.js";
import protect from "../middleware/auth.middleware.js";
import { loadFreelancer, requireFreelancerOwner } from "../middleware/freelancer.middleware.js";

const router = express.Router();

// All freelancer routes require authentication — the directory (including
// contact details) is only for logged-in users looking to hire, matching
// the frontend's ProtectedRoute gating on /hire-freelancers*. Enforced here
// too, not just client-side.
router.use(protect);

router.get("/", getFreelancers);
router.get("/:id", getFreelancerById);
router.post("/", createFreelancer);
router.patch("/:id", loadFreelancer, requireFreelancerOwner, updateFreelancer);
router.delete("/:id", loadFreelancer, requireFreelancerOwner, deleteFreelancer);

export default router;
