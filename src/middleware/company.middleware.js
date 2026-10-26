import Company from "../models/company.model.js";
import { isAdminRole } from "../utils/roles.js";

export const loadCompanyBySlug = async (req, res, next) => {
  try {
    const company = await Company.findOne({ slug: req.params.slug });

    if (!company) {
      return res.status(404).json({ message: "Company not found." });
    }

    req.company = company;
    return next();
  } catch (error) {
    console.error(error);

    return res.status(500).json({ message: "Failed to load company." });
  }
};

export const requireAdmin = (req, res, next) => {
  if (!isAdminRole(req.user.role)) {
    return res.status(403).json({
      message: "Only an admin can modify company profiles.",
    });
  }

  return next();
};
