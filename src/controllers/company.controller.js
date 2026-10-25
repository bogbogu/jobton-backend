import Company from "../models/company.model.js";
import { isInputError, validationErrorBody } from "../utils/errors.utils.js";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const serializeCompany = (company) => ({
  id: company._id.toString(),
  name: company.name,
  slug: company.slug,
  domain: company.domain,
  logo_url: company.logoUrl || null,
  description: company.description,
  website: company.website,
  industry: company.industry,
  location: company.location,
});

const parsePagination = (query) => {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(query.limit, 10) || DEFAULT_PAGE_SIZE));
  return { page, limit };
};

export const getCompanies = async (req, res) => {
  try {
    // Query values can be arrays (?keyword=a&keyword=b); only a plain string is used.
    const keyword = typeof req.query.keyword === "string" ? req.query.keyword.trim() : "";
    const filter = {};

    if (keyword) {
      filter.name = new RegExp(escapeRegExp(keyword), "i");
    }

    const { page, limit } = parsePagination(req.query);

    const [companies, total] = await Promise.all([
      Company.find(filter)
        .sort({ name: 1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Company.countDocuments(filter),
    ]);

    return res.status(200).json({
      message: "Companies retrieved successfully.",
      companies: companies.map(serializeCompany),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 0,
      },
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: "Failed to fetch companies.",
    });
  }
};

export const getCompanyBySlug = async (req, res) => {
  return res.status(200).json({
    message: "Company retrieved successfully.",
    company: serializeCompany(req.company),
  });
};

export const createCompany = async (req, res) => {
  try {
    const { name, domain, logoUrl, description, website, industry, location } = req.body || {};

    if (!name) {
      return res.status(400).json({ message: "name is required." });
    }

    const company = await Company.create({
      name,
      domain,
      logoUrl,
      description,
      website,
      industry,
      location,
      createdBy: req.user._id,
    });

    return res.status(201).json({
      message: "Company created successfully.",
      company: serializeCompany(company),
    });
  } catch (error) {
    console.error(error);

    if (error.code === 11000) {
      return res.status(409).json({ message: "A company with this name already exists." });
    }

    if (isInputError(error)) {
      return res.status(400).json(validationErrorBody(error));
    }

    return res.status(500).json({
      message: "Failed to create company.",
    });
  }
};

const UPDATABLE_COMPANY_FIELDS = ["name", "domain", "logoUrl", "description", "website", "industry", "location"];

export const updateCompany = async (req, res) => {
  try {
    const company = req.company;

    for (const field of UPDATABLE_COMPANY_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, field)) {
        company[field] = req.body[field];
      }
    }

    await company.save({ validateModifiedOnly: true });

    return res.status(200).json({
      message: "Company updated successfully.",
      company: serializeCompany(company),
    });
  } catch (error) {
    console.error(error);

    if (error.code === 11000) {
      return res.status(409).json({ message: "A company with this name already exists." });
    }

    if (isInputError(error)) {
      return res.status(400).json(validationErrorBody(error));
    }

    return res.status(500).json({
      message: "Failed to update company.",
    });
  }
};

export const deleteCompany = async (req, res) => {
  try {
    await req.company.deleteOne();

    return res.status(200).json({
      message: "Company deleted successfully.",
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: "Failed to delete company.",
    });
  }
};
