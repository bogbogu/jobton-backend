import express from "express";
import {
  getCompanies,
  getCompanyBySlug,
  createCompany,
  updateCompany,
  deleteCompany,
} from "../controllers/company.controller.js";
import protect from "../middleware/auth.middleware.js";
import { loadCompanyBySlug, requireAdmin } from "../middleware/company.middleware.js";

const router = express.Router();

router.get("/", getCompanies);
router.get("/:slug", loadCompanyBySlug, getCompanyBySlug);

router.post("/", protect, createCompany);
router.patch("/:slug", protect, loadCompanyBySlug, requireAdmin, updateCompany);
router.delete("/:slug", protect, loadCompanyBySlug, requireAdmin, deleteCompany);

export default router;
