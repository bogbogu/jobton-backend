import mongoose from "mongoose";
import Job from "../models/job.model.js";
import { formatSalaryDisplay, formatRelativeDate, formatLongDate } from "../utils/format.utils.js";

const DEFAULT_PAGE_SIZE = 12;
const MAX_PAGE_SIZE = 50;

const SORT_MAP = {
  MOST_RECENT: { createdAt: -1 },
  OLDEST: { createdAt: 1 },
  HIGHEST_SALARY: { salaryMax: -1, salaryMin: -1 },
  MOST_APPLICANTS: { applicants: -1 },
};

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const serializeJob = (job) => ({
  id: job._id.toString(),
  company: job.company,
  domain: job.domain,
  logo_url: job.logoUrl || null,
  title: job.title,
  location: job.location,
  type: job.employmentType,
  salary: formatSalaryDisplay(job),
  category: job.category,
  status: job.status,
  skills: job.skills,
  posted: formatRelativeDate(job.createdAt),
  applicants: job.applicants,
  datePosted: formatLongDate(job.createdAt),
  industry: job.industry,
  experience: job.experience,
  qualification: job.qualification,
  description: job.description,
  responsibilities: job.responsibilities,
  applicationLink: job.applicationLink,
  postedBy: job.postedBy ? job.postedBy.toString() : null,
});

const buildJobFilter = (query) => {
  const filter = {};
  const { keyword, location, type, industry, category } = query;

  if (keyword) {
    const pattern = new RegExp(escapeRegExp(String(keyword).trim()), "i");
    filter.$or = [{ title: pattern }, { company: pattern }, { skills: pattern }];
  }

  if (location) {
    filter.location = new RegExp(escapeRegExp(String(location).trim()), "i");
  }

  if (type) {
    filter.employmentType = type;
  }

  if (industry) {
    filter.industry = industry;
  }

  if (category) {
    filter.category = category;
  }

  return filter;
};

const parsePagination = (query) => {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(query.limit, 10) || DEFAULT_PAGE_SIZE));
  return { page, limit };
};

export const getJobs = async (req, res) => {
  try {
    const filter = buildJobFilter(req.query);
    const sort = SORT_MAP[req.query.sort] || SORT_MAP.MOST_RECENT;
    const { page, limit } = parsePagination(req.query);

    const [jobs, total] = await Promise.all([
      Job.find(filter)
        .sort(sort)
        .skip((page - 1) * limit)
        .limit(limit),
      Job.countDocuments(filter),
    ]);

    return res.status(200).json({
      message: "Jobs retrieved successfully.",
      jobs: jobs.map(serializeJob),
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
      message: "Failed to fetch jobs.",
    });
  }
};

export const getJobById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ message: "Job not found." });
    }

    const job = await Job.findById(id);

    if (!job) {
      return res.status(404).json({ message: "Job not found." });
    }

    return res.status(200).json({
      message: "Job retrieved successfully.",
      job: serializeJob(job),
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: "Failed to fetch job.",
    });
  }
};

export const createJob = async (req, res) => {
  try {
    const {
      title,
      company,
      domain,
      logoUrl,
      location,
      employmentType,
      salaryMin,
      salaryMax,
      salaryCurrency,
      salaryPeriod,
      category,
      status,
      skills,
      industry,
      experience,
      qualification,
      description,
      responsibilities,
      applicationLink,
    } = req.body || {};

    if (
      !title ||
      !company ||
      !location ||
      !employmentType ||
      !salaryMin ||
      !category ||
      !description ||
      !applicationLink
    ) {
      return res.status(400).json({
        message:
          "title, company, location, employmentType, salaryMin, category, description, and applicationLink are required.",
      });
    }

    const job = await Job.create({
      title,
      company,
      domain,
      logoUrl,
      location,
      employmentType,
      salaryMin,
      salaryMax,
      salaryCurrency,
      salaryPeriod,
      category,
      status,
      skills,
      industry,
      experience,
      qualification,
      description,
      responsibilities,
      applicationLink,
      postedBy: req.user._id,
    });

    return res.status(201).json({
      message: "Job created successfully.",
      job: serializeJob(job),
    });
  } catch (error) {
    console.error(error);

    if (error.name === "ValidationError") {
      return res.status(400).json({ message: error.message });
    }

    return res.status(500).json({
      message: "Failed to create job.",
    });
  }
};

const UPDATABLE_JOB_FIELDS = [
  "title",
  "company",
  "domain",
  "logoUrl",
  "location",
  "employmentType",
  "salaryMin",
  "salaryMax",
  "salaryCurrency",
  "salaryPeriod",
  "category",
  "status",
  "skills",
  "industry",
  "experience",
  "qualification",
  "description",
  "responsibilities",
  "applicationLink",
];

export const updateJob = async (req, res) => {
  try {
    const job = req.job;

    for (const field of UPDATABLE_JOB_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, field)) {
        job[field] = req.body[field];
      }
    }

    await job.save();

    return res.status(200).json({
      message: "Job updated successfully.",
      job: serializeJob(job),
    });
  } catch (error) {
    console.error(error);

    if (error.name === "ValidationError") {
      return res.status(400).json({ message: error.message });
    }

    return res.status(500).json({
      message: "Failed to update job.",
    });
  }
};

export const deleteJob = async (req, res) => {
  try {
    await req.job.deleteOne();

    return res.status(200).json({
      message: "Job deleted successfully.",
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: "Failed to delete job.",
    });
  }
};
