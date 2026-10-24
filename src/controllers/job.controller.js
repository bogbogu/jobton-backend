import mongoose from "mongoose";
import Job from "../models/job.model.js";
import SavedJob from "../models/savedJob.model.js";
import { formatSalaryDisplay, formatRelativeDate, formatLongDate } from "../utils/format.utils.js";
import { slugify } from "../utils/slugify.utils.js";
import { publicJobFilter, isPublishedJob } from "../utils/jobVisibility.js";

const DEFAULT_PAGE_SIZE = 12;
const MAX_PAGE_SIZE = 50;

const SORT_MAP = {
  MOST_RECENT: { createdAt: -1 },
  OLDEST: { createdAt: 1 },
  HIGHEST_SALARY: { salaryMax: -1, salaryMin: -1 },
  MOST_APPLICANTS: { applicants: -1 },
};

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Public shape. Review/ingestion internals (reviewStatus, review, extraction,
// dedupeKey, source.messageId, source.postedAt) must NEVER appear here; admin
// code builds its own view on top of this.
export const serializeJob = (job, { saved = false } = {}) => ({
  id: job._id.toString(),
  company: job.company ?? null,
  companySlug: job.company ? slugify(job.company) : null,
  domain: job.domain,
  logo_url: job.logoUrl || null,
  title: job.title,
  location: job.location ?? null,
  type: job.employmentType || null,
  workArrangement: job.workArrangement || null,
  salary: formatSalaryDisplay(job),
  category: job.category ?? null,
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
  applicationLink: job.applicationLink || null,
  applyEmail: job.applyEmail || null,
  applyPhone: job.applyPhone || null,
  source: job.source?.kind
    ? { kind: job.source.kind, channel: job.source.channel || null, url: job.source.url || null }
    : null,
  postedBy: job.postedBy ? job.postedBy.toString() : null,
  saved,
});

// Builds a Set of job-id strings the given user has saved, scoped to just
// the jobs being serialized right now — avoids pulling every SavedJob a
// user has ever created when we only need to know about this page's worth.
const getSavedJobIdSet = async (userId, jobIds) => {
  if (!userId || jobIds.length === 0) return new Set();

  const savedDocs = await SavedJob.find({ user: userId, job: { $in: jobIds } }).select("job");
  return new Set(savedDocs.map((doc) => doc.job.toString()));
};

// Express 5 can hand us arrays/objects (?industry=a&industry=b, ?industry[$ne]=x).
// Only plain non-empty strings are accepted; anything else is ignored.
const asString = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);

const buildJobFilter = (query) => {
  const conditions = [];
  const keyword = asString(query.keyword);
  const location = asString(query.location);
  const type = asString(query.type);
  const industry = asString(query.industry);
  const category = asString(query.category);
  const company = asString(query.company);

  if (keyword) {
    const pattern = new RegExp(escapeRegExp(keyword), "i");
    conditions.push({ $or: [{ title: pattern }, { company: pattern }, { skills: pattern }] });
  }

  if (location) {
    conditions.push({ location: new RegExp(escapeRegExp(location), "i") });
  }

  if (type) {
    // `type` matches either employment type (Full-time/Contract/...) or
    // work arrangement (Remote/On-site/Hybrid) — the frontend's job-type
    // filter dropdown mixes both taxonomies into one list.
    conditions.push({ $or: [{ employmentType: type }, { workArrangement: type }] });
  }

  if (industry) {
    conditions.push({ industry });
  }

  if (category) {
    conditions.push({ category });
  }

  if (company) {
    conditions.push({ company });
  }

  // Allow-list: non-published jobs never reach the public list or its total.
  return { $and: [publicJobFilter(), ...conditions] };
};

const parsePagination = (query) => {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(query.limit, 10) || DEFAULT_PAGE_SIZE));
  return { page, limit };
};

export const getJobs = async (req, res) => {
  try {
    const filter = buildJobFilter(req.query);
    const sortKey = asString(req.query.sort);
    const sort =
      sortKey && Object.prototype.hasOwnProperty.call(SORT_MAP, sortKey)
        ? SORT_MAP[sortKey]
        : SORT_MAP.MOST_RECENT;
    const { page, limit } = parsePagination(req.query);

    const [jobs, total] = await Promise.all([
      Job.find(filter)
        .sort(sort)
        .skip((page - 1) * limit)
        .limit(limit),
      Job.countDocuments(filter),
    ]);

    const savedJobIds = await getSavedJobIdSet(
      req.user?._id,
      jobs.map((job) => job._id)
    );

    return res.status(200).json({
      message: "Jobs retrieved successfully.",
      jobs: jobs.map((job) => serializeJob(job, { saved: savedJobIds.has(job._id.toString()) })),
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

    // Hidden jobs look exactly like missing ones.
    if (!job || !isPublishedJob(job)) {
      return res.status(404).json({ message: "Job not found." });
    }

    const savedJobIds = await getSavedJobIdSet(req.user?._id, [job._id]);

    return res.status(200).json({
      message: "Job retrieved successfully.",
      job: serializeJob(job, { saved: savedJobIds.has(job._id.toString()) }),
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: "Failed to fetch job.",
    });
  }
};

const isMissing = (value) => value === undefined || value === null || value === "";

export const createJob = async (req, res) => {
  try {
    // Deliberately NOT read from the body: reviewStatus, review, source,
    // extraction, dedupeKey, applyEmail, applyPhone, postedBy.
    const {
      title,
      company,
      domain,
      logoUrl,
      location,
      employmentType,
      workArrangement,
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

    const isAdmin = req.user.role === "admin";

    if (
      !title ||
      !company ||
      !location ||
      !employmentType ||
      isMissing(salaryMin) ||
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
      workArrangement,
      salaryMin,
      salaryMax,
      salaryCurrency,
      salaryPeriod,
      category,
      // Badges (especially "verified") are admin-only; silently dropped otherwise.
      status: isAdmin ? status : undefined,
      skills,
      industry,
      experience,
      qualification,
      description,
      responsibilities,
      applicationLink,
      postedBy: req.user._id,
      reviewStatus: isAdmin ? "published" : "pending_review",
    });

    return res.status(201).json({
      message: isAdmin ? "Job created successfully." : "Job submitted for review.",
      job: serializeJob(job),
    });
  } catch (error) {
    console.error(error);

    if (error.name === "ValidationError") {
      return res.status(400).json({ message: error.message });
    }

    if (error.name === "CastError") {
      return res.status(400).json({ message: `Invalid value for ${error.path}.` });
    }

    return res.status(500).json({
      message: "Failed to create job.",
    });
  }
};

// reviewStatus, review, source, extraction, dedupeKey, applyEmail, applyPhone
// and postedBy are never updatable through this endpoint.
const UPDATABLE_JOB_FIELDS = [
  "title",
  "company",
  "domain",
  "logoUrl",
  "location",
  "employmentType",
  "workArrangement",
  "salaryMin",
  "salaryMax",
  "salaryCurrency",
  "salaryPeriod",
  "category",
  "skills",
  "industry",
  "experience",
  "qualification",
  "description",
  "responsibilities",
  "applicationLink",
];

// Badges: only an admin may change these.
const ADMIN_ONLY_JOB_FIELDS = ["status"];

export const updateJob = async (req, res) => {
  try {
    const job = req.job;
    const isAdmin = req.user.role === "admin";
    const fields = isAdmin ? [...UPDATABLE_JOB_FIELDS, ...ADMIN_ONLY_JOB_FIELDS] : UPDATABLE_JOB_FIELDS;

    for (const field of fields) {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, field)) {
        job[field] = req.body[field];
      }
    }

    // An owner's edit must be re-reviewed, otherwise an approved job could be
    // swapped for a malicious link. It is forced even when the job is already
    // pending (markModified makes Mongoose $set it unconditionally), so an
    // admin approving concurrently with this edit cannot publish the edited
    // content. Rejected jobs stay rejected. Admin edits never change it.
    if (!isAdmin && job.reviewStatus !== "rejected") {
      job.reviewStatus = "pending_review";
      job.markModified("reviewStatus");
    }

    // Validate exactly the paths this request changed: old documents may hold
    // values the newer validators would reject, and an unrelated edit must not
    // fail on them. validate(paths) also surfaces uncastable values, which
    // save({ validateModifiedOnly }) would silently drop.
    await job.validate(job.modifiedPaths());
    await job.save({ validateBeforeSave: false });

    return res.status(200).json({
      message: "Job updated successfully.",
      job: serializeJob(job),
    });
  } catch (error) {
    console.error(error);

    if (error.name === "ValidationError") {
      return res.status(400).json({ message: error.message });
    }

    if (error.name === "CastError") {
      return res.status(400).json({ message: `Invalid value for ${error.path}.` });
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

// Registered before GET /:id (see job.route.js) — otherwise Express would
// treat "saved" as an :id value and this would never be reached.
export const getSavedJobs = async (req, res) => {
  try {
    const { page, limit } = parsePagination(req.query);

    // Count and page over VISIBLE saved jobs only. Filtering after paging
    // would return short/empty pages and a total that includes hidden jobs.
    const [result] = await SavedJob.aggregate([
      { $match: { user: req.user._id } },
      {
        $lookup: {
          from: Job.collection.name,
          localField: "job",
          foreignField: "_id",
          pipeline: [{ $match: publicJobFilter() }, { $project: { _id: 1 } }],
          as: "visible",
        },
      },
      { $match: { "visible.0": { $exists: true } } },
      { $sort: { createdAt: -1, _id: -1 } },
      {
        $facet: {
          items: [{ $skip: (page - 1) * limit }, { $limit: limit }, { $project: { job: 1 } }],
          count: [{ $count: "total" }],
        },
      },
    ]);

    const total = result?.count?.[0]?.total || 0;
    const orderedIds = (result?.items || []).map((item) => item.job);

    const found = await Job.find({ _id: { $in: orderedIds } });
    const byId = new Map(found.map((job) => [job._id.toString(), job]));
    const jobs = orderedIds
      .map((id) => byId.get(id.toString()))
      .filter(Boolean)
      .map((job) => serializeJob(job, { saved: true }));

    return res.status(200).json({
      message: "Saved jobs retrieved successfully.",
      jobs,
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
      message: "Failed to fetch saved jobs.",
    });
  }
};

export const saveJob = async (req, res) => {
  try {
    // loadJob lets owners/admins reach their own hidden jobs; nobody saves one.
    if (!isPublishedJob(req.job)) {
      return res.status(404).json({ message: "Job not found." });
    }

    await SavedJob.updateOne(
      { user: req.user._id, job: req.job._id },
      { $setOnInsert: { user: req.user._id, job: req.job._id } },
      { upsert: true }
    );

    return res.status(200).json({
      message: "Job saved.",
      saved: true,
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: "Failed to save job.",
    });
  }
};

// Stays allowed for hidden jobs so users can clean up old saves.
export const unsaveJob = async (req, res) => {
  try {
    await SavedJob.deleteOne({ user: req.user._id, job: req.job._id });

    return res.status(200).json({
      message: "Job removed from saved jobs.",
      saved: false,
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: "Failed to unsave job.",
    });
  }
};
