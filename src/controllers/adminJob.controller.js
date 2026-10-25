import mongoose from "mongoose";
import Job from "../models/job.model.js";
import TelegramPost from "../models/telegramPost.model.js";
import { serializeJob } from "./job.controller.js";
import { publicJobFilter, REVIEW_STATUSES } from "../utils/jobVisibility.js";
import { cleanText } from "../utils/validators.utils.js";
import { toFieldErrors } from "../utils/errors.utils.js";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;
const MAX_BULK_REJECT = 100;
const MAX_REASON_LENGTH = 500;
const JOB_STATUS_BADGES = ["featured", "verified", "urgent", "new"];

// The ONLY fields an admin may change while approving. Everything else in
// `edits` (reviewStatus, source, extraction, review, dedupeKey, postedBy, ...)
// is ignored, never copied.
const APPROVAL_EDITABLE_FIELDS = [
  "title",
  "company",
  "domain",
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
  "applyEmail",
  "applyPhone",
];

// ObjectId.isValid also accepts any 12-character string; require the 24-hex form.
const isObjectIdString = (value) =>
  typeof value === "string" &&
  /^[0-9a-fA-F]{24}$/.test(value) &&
  mongoose.Types.ObjectId.isValid(value);

// Express 5 may hand back arrays/objects for repeated or nested query keys.
const asString = (value) => (typeof value === "string" ? value : undefined);

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

const idToString = (value) => (value ? value.toString() : null);

const audit = (action, adminId, jobId, extra = "") => {
  // Ids only: never post text, emails or phone numbers.
  console.info(
    `[admin-audit] action=${action} admin=${adminId} job=${jobId}${extra ? ` ${extra}` : ""}`
  );
};

export const serializeAdminJob = (job) => {
  const plain = typeof job.toObject === "function" ? job.toObject() : job;
  const review = plain.review || {};
  const source = plain.source || {};
  const extraction = plain.extraction || {};

  return {
    ...serializeJob(job),
    // Admin-only: the public serializer never exposes the poster's user id.
    postedBy: idToString(plain.postedBy),
    // Raw values the review form needs to pre-fill.
    employmentType: plain.employmentType,
    salaryMin: plain.salaryMin ?? null,
    salaryMax: plain.salaryMax ?? null,
    salaryCurrency: plain.salaryCurrency,
    salaryPeriod: plain.salaryPeriod ?? null,
    applyEmail: plain.applyEmail || null,
    applyPhone: plain.applyPhone || null,
    reviewStatus: plain.reviewStatus || "published",
    review: {
      reviewedBy: idToString(review.reviewedBy),
      reviewedAt: review.reviewedAt || null,
      rejectionReason: review.rejectionReason || null,
    },
    source: {
      kind: source.kind || null,
      channel: source.channel || null,
      messageId: source.messageId ?? null,
      url: source.url || null,
      postedAt: source.postedAt || null,
    },
    extraction: {
      ...extraction,
      post: idToString(extraction.post),
    },
    createdAt: plain.createdAt,
    updatedAt: plain.updatedAt,
  };
};

const parsePagination = (query) => {
  const page = Math.max(1, parseInt(asString(query.page), 10) || 1);
  const limit = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, parseInt(asString(query.limit), 10) || DEFAULT_PAGE_SIZE)
  );
  return { page, limit };
};

const buildReviewStatusFilter = (reviewStatus) =>
  // Legacy documents have no reviewStatus and count as published.
  reviewStatus === "published" ? publicJobFilter() : { reviewStatus };

export const listAdminJobs = async (req, res) => {
  try {
    const rawStatus = req.query.reviewStatus;
    let reviewStatus = "pending_review";

    if (rawStatus !== undefined && rawStatus !== "") {
      if (typeof rawStatus !== "string" || !REVIEW_STATUSES.includes(rawStatus)) {
        return res.status(400).json({
          message: `reviewStatus must be one of: ${REVIEW_STATUSES.join(", ")}.`,
          error: "INVALID_REVIEW_STATUS",
        });
      }
      reviewStatus = rawStatus;
    }

    const filter = buildReviewStatusFilter(reviewStatus);
    const channel = asString(req.query.channel)?.trim().toLowerCase();
    if (channel) {
      filter["source.channel"] = channel;
    }

    const { page, limit } = parsePagination(req.query);

    const [jobs, total] = await Promise.all([
      Job.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Job.countDocuments(filter),
    ]);

    return res.status(200).json({
      message: "Jobs retrieved successfully.",
      jobs: jobs.map(serializeAdminJob),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 0,
      },
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

export const getAdminJob = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isObjectIdString(id)) {
      return res.status(404).json({ message: "Job not found." });
    }

    const job = await Job.findById(id);

    if (!job) {
      return res.status(404).json({ message: "Job not found." });
    }

    let rawPost = null;
    const postId = job.extraction?.post;

    if (postId) {
      // null when the raw post has been purged by its TTL index.
      const post = await TelegramPost.findById(postId).select("text links hasImage postedAt");

      if (post) {
        rawPost = {
          text: post.text,
          links: (post.links || []).map((link) => ({ href: link.href, label: link.label })),
          hasImage: post.hasImage,
          postedAt: post.postedAt || null,
        };
      }
    }

    return res.status(200).json({
      message: "Job retrieved successfully.",
      job: serializeAdminJob(job),
      rawPost,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

export const approveJob = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isObjectIdString(id)) {
      return res.status(404).json({ message: "Job not found." });
    }

    const body = req.body || {};
    const edits = body.edits === undefined || body.edits === null ? {} : body.edits;

    if (typeof edits !== "object" || Array.isArray(edits)) {
      return res.status(400).json({
        message: "edits must be an object.",
        error: "INVALID_EDITS",
      });
    }

    let badges;
    if (body.status !== undefined) {
      if (
        !Array.isArray(body.status) ||
        !body.status.every((badge) => JOB_STATUS_BADGES.includes(badge))
      ) {
        return res.status(400).json({
          message: `status must be an array of: ${JOB_STATUS_BADGES.join(", ")}.`,
          error: "INVALID_STATUS",
        });
      }
      badges = [...new Set(body.status)];
    }

    // Required: an admin can never publish a version they did not look at.
    // Checked before any database access.
    if (body.expectedUpdatedAt === undefined || body.expectedUpdatedAt === null) {
      return res.status(400).json({
        message:
          "expectedUpdatedAt is required: send the updatedAt of the job version you reviewed.",
        error: "EXPECTED_UPDATED_AT_REQUIRED",
      });
    }

    const current = await Job.findById(id);

    if (!current) {
      return res.status(404).json({ message: "Job not found." });
    }

    if (current.reviewStatus !== "pending_review") {
      return res.status(409).json({
        message: "Job is not pending review.",
        error: "NOT_PENDING",
      });
    }

    // Version check: the review UI sends the updatedAt of the version the admin
    // actually looked at, so an owner edit made in the meantime cannot be
    // approved unseen.
    // Only a string or a number can be a timestamp. Anything else (an object with a
    // custom toString, an array, a boolean) would be coerced by `new Date()` or throw,
    // so it is treated as a stale version instead of reaching the Date constructor.
    const rawVersion = body.expectedUpdatedAt;
    const expected = typeof rawVersion === "string" || typeof rawVersion === "number" ? new Date(rawVersion) : null;
    if (
      !expected ||
      Number.isNaN(expected.getTime()) ||
      !current.updatedAt ||
      expected.getTime() !== current.updatedAt.getTime()
    ) {
      return res.status(409).json({
        message: "This job changed after you opened it. Reload it and review again.",
        error: "STALE",
      });
    }

    const appliedEdits = {};
    for (const field of APPROVAL_EDITABLE_FIELDS) {
      if (hasOwn(edits, field)) {
        appliedEdits[field] = edits[field];
      }
    }
    if (badges) {
      appliedEdits.status = badges;
    }

    // Validate the merged result with the real schema rules (conditional
    // required fields, URL/email/phone validators, enums, text cleaning).
    const candidate = new Job({ ...current.toObject(), ...appliedEdits });
    let validationError = null;
    try {
      await candidate.validate();
    } catch (error) {
      if (error.name !== "ValidationError") throw error;
      validationError = error;
    }

    const missing = [];
    for (const field of ["title", "description", "company", "location", "category"]) {
      if (!candidate[field]) missing.push(field);
    }
    if (!candidate.applicationLink && !candidate.applyEmail && !candidate.applyPhone) {
      missing.push("applyContact");
    }

    if (missing.length > 0) {
      return res.status(400).json({
        message: `Cannot publish: missing ${missing.join(", ")}.`,
        error: "MISSING_FIELDS",
        missing,
      });
    }

    if (validationError) {
      return res.status(400).json({
        message: "Validation failed.",
        error: "VALIDATION_ERROR",
        fields: toFieldErrors(validationError),
      });
    }

    // Persist the validated (cleaned/cast) values, not the raw request values.
    const validated = candidate.toObject();
    const set = {};
    for (const field of Object.keys(appliedEdits)) {
      if (validated[field] !== undefined) {
        set[field] = validated[field];
      }
    }

    const published = await Job.findOneAndUpdate(
      // updatedAt in the filter: an owner edit landing between our read and
      // this write changes it, so unseen content is never published.
      { _id: current._id, reviewStatus: "pending_review", updatedAt: current.updatedAt },
      {
        $set: {
          ...set,
          reviewStatus: "published",
          "review.reviewedBy": req.user._id,
          "review.reviewedAt": new Date(),
        },
      },
      { returnDocument: "after" }
    );

    if (!published) {
      const latest = await Job.findById(current._id).select("reviewStatus");
      if (latest && latest.reviewStatus === "pending_review") {
        return res.status(409).json({
          message: "This job changed after you opened it. Reload it and review again.",
          error: "STALE",
        });
      }
      return res.status(409).json({
        message: "Job is not pending review.",
        error: "NOT_PENDING",
      });
    }

    audit("approve", req.user._id, published._id);

    return res.status(200).json({
      message: "Job approved and published.",
      job: serializeAdminJob(published),
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

// Returns { reason } (possibly undefined) or { error: <response body> }.
const parseReason = (value) => {
  if (value === undefined || value === null) return { reason: undefined };

  if (typeof value !== "string") {
    return {
      error: { message: "reason must be a string.", error: "INVALID_REASON" },
    };
  }

  const reason = cleanText(value);

  if (reason.length > MAX_REASON_LENGTH) {
    return {
      error: {
        message: `reason must be at most ${MAX_REASON_LENGTH} characters.`,
        error: "INVALID_REASON",
      },
    };
  }

  return { reason: reason || undefined };
};

const rejectionUpdate = (adminId, reason) => ({
  $set: {
    reviewStatus: "rejected",
    "review.reviewedBy": adminId,
    "review.reviewedAt": new Date(),
    ...(reason ? { "review.rejectionReason": reason } : {}),
  },
});

export const rejectJob = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isObjectIdString(id)) {
      return res.status(404).json({ message: "Job not found." });
    }

    const parsed = parseReason((req.body || {}).reason);
    if (parsed.error) {
      return res.status(400).json(parsed.error);
    }

    const rejected = await Job.findOneAndUpdate(
      { _id: id, reviewStatus: "pending_review" },
      rejectionUpdate(req.user._id, parsed.reason),
      { returnDocument: "after" }
    );

    if (!rejected) {
      const exists = await Job.exists({ _id: id });

      if (!exists) {
        return res.status(404).json({ message: "Job not found." });
      }

      return res.status(409).json({
        message: "Job is not pending review.",
        error: "NOT_PENDING",
      });
    }

    audit("reject", req.user._id, rejected._id);

    return res.status(200).json({
      message: "Job rejected.",
      job: serializeAdminJob(rejected),
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

export const bulkRejectJobs = async (req, res) => {
  try {
    const body = req.body || {};
    const { ids } = body;

    if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_BULK_REJECT) {
      return res.status(400).json({
        message: `ids must be an array of 1 to ${MAX_BULK_REJECT} job ids.`,
        error: "INVALID_IDS",
      });
    }

    if (!ids.every(isObjectIdString)) {
      return res.status(400).json({
        message: "ids must all be valid job ids.",
        error: "INVALID_IDS",
      });
    }

    const parsed = parseReason(body.reason);
    if (parsed.error) {
      return res.status(400).json(parsed.error);
    }

    const uniqueIds = [...new Set(ids)];

    const result = await Job.updateMany(
      { _id: { $in: uniqueIds }, reviewStatus: "pending_review" },
      rejectionUpdate(req.user._id, parsed.reason)
    );

    const rejected = result.modifiedCount ?? 0;

    console.info(
      `[admin-audit] action=bulk-reject admin=${req.user._id} requested=${uniqueIds.length} rejected=${rejected}`
    );

    return res.status(200).json({
      message: `${rejected} job(s) rejected.`,
      rejected,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Internal server error." });
  }
};
