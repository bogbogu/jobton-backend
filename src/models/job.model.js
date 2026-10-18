import mongoose from "mongoose";
import { REVIEW_STATUSES } from "../utils/jobVisibility.js";
import {
  LINK_CLASSES,
  cleanText,
  isSafeHttpUrl,
  isValidDomain,
  isValidEmail,
  isValidStoredPhone,
} from "../utils/validators.utils.js";

const SALARY_CURRENCIES = ["NGN", "USD"];
// `null` = "pay period not stated" (common on ingested jobs).
const SALARY_PERIODS = ["hour", "month", "year", null];
const WORK_ARRANGEMENTS = ["On-site", "Remote", "Hybrid"];
const SOURCE_KINDS = ["telegram"];

// Jobs that come from an ingestion source (source.kind set) are often
// incomplete; they wait in review until an admin fills the gaps. Jobs posted
// directly through the API keep the original required fields.
//
// This reads `this.source`, so it only works when `this` is a document, i.e.
// validation of save()/create()/doc.validate(). Update validators
// (runValidators on findOneAndUpdate/updateOne) run with the Query as `this`:
// `this.source` is undefined there, so every field would be treated as
// required. Never rely on update validators for ingested jobs; validate a
// document built from the merged values instead (see adminJob.controller.js).
function requiredUnlessIngested() {
  return !(this.source && this.source.kind);
}
const required = (message) => [requiredUnlessIngested, message];

const textField = (extra = {}) => ({ type: String, trim: true, set: cleanText, ...extra });
const urlValidator = {
  validator: (value) => value === undefined || value === null || value === "" || isSafeHttpUrl(value),
  message: "{PATH} must be an http(s) URL.",
};

const JobSchema = new mongoose.Schema(
  {
    title: textField({
      required: [true, "Job title is required"],
      maxlength: 200,
    }),

    company: textField({
      required: required("Company name is required"),
      maxlength: 200,
    }),

    domain: {
      type: String,
      trim: true,
      default: "",
      validate: {
        validator: isValidDomain,
        message: "domain must be a plain hostname, e.g. example.com.",
      },
    },

    logoUrl: {
      type: String,
      default: "",
      validate: urlValidator,
    },

    location: textField({
      required: required("Job location is required"),
      maxlength: 200,
    }),

    // Spelled "Full Time"/"Part Time" (not "Full-time"/"Part-time") to match
    // the frontend's existing jobTypeOptions wording exactly — the API
    // returns and filters on this value verbatim, no translation layer.
    employmentType: {
      type: String,
      required: required("Employment type is required"),
      enum: [
        "Full Time",
        "Part Time",
        "Contract",
        "Internship",
        "Temporary",
        "Freelance",
      ],
    },

    // Separate from `employmentType` on purpose: a job can be Full-time AND
    // Hybrid at the same time. The frontend's mock data used to conflate
    // these into one `type` field ("Full Time", "On-site", "Contract",
    // "Hybrid") — nullable since not every posting specifies it.
    workArrangement: {
      type: String,
      enum: WORK_ARRANGEMENTS,
      default: null,
    },

    // Structured so the API can sort/filter by salary; `salary` display
    // strings (e.g. "$8,000 / month") are derived from these at read time.
    // Optional for ingested jobs: most Telegram posts don't state pay.
    salaryMin: {
      type: Number,
      required: required("Minimum salary is required"),
      min: 0,
    },

    salaryMax: {
      type: Number,
      min: 0,
      default: null,
    },

    salaryCurrency: {
      type: String,
      enum: SALARY_CURRENCIES,
      default: "NGN",
    },

    salaryPeriod: {
      type: String,
      enum: SALARY_PERIODS,
      default: "month",
    },

    // Role/function taxonomy for the "browse by category" pages
    // (e.g. "Design", "Software Development") — distinct from `industry`,
    // which describes the employer's sector (e.g. "Fintech").
    category: textField({
      required: required("Category is required"),
      maxlength: 100,
    }),

    // Badges. Only an admin may set these (enforced in the controllers):
    // "verified" is Jobton's core promise and must never be self-assigned.
    status: {
      type: [String],
      enum: ["featured", "verified", "urgent", "new"],
      default: [],
    },

    skills: {
      type: [{ type: String, trim: true, set: cleanText, maxlength: 100 }],
      default: [],
    },

    industry: textField({ default: "", maxlength: 100 }),

    experience: textField({ default: "", maxlength: 200 }),

    qualification: textField({ default: "", maxlength: 300 }),

    description: textField({
      required: [true, "Job description is required"],
      maxlength: 10000,
    }),

    responsibilities: {
      type: [{ type: String, trim: true, set: cleanText, maxlength: 500 }],
      default: [],
    },

    // A URL to apply at. http(s) only — it is rendered as an <a href> by the
    // frontend, so javascript:/data: schemes must never be storable.
    // Ingested jobs may instead (or additionally) carry applyEmail/applyPhone.
    applicationLink: {
      type: String,
      required: required("Application link is required"),
      trim: true,
      validate: urlValidator,
    },

    // Apply by email / phone. Shown as copyable text plus tap-to-act buttons;
    // the frontend builds mailto:/tel: from these validated values only.
    applyEmail: {
      type: String,
      trim: true,
      lowercase: true,
      default: undefined,
      validate: {
        validator: (value) => value === undefined || value === null || value === "" || isValidEmail(value),
        message: "applyEmail must be a valid email address.",
      },
    },

    applyPhone: {
      type: String,
      trim: true,
      default: undefined,
      validate: {
        validator: isValidStoredPhone,
        message: "applyPhone must be a normalized phone number (digits, optional leading +).",
      },
    },

    // Placeholder counter until a real Application domain exists.
    // Not incremented anywhere yet — defaults to 0 for every new job.
    applicants: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Optional: who posted this job. Nullable so admin/seed-created jobs
    // without a specific owner remain admin-only to modify.
    postedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    // ---- Review workflow -------------------------------------------------
    // Only "published" jobs are visible to the public (see utils/jobVisibility.js).
    // Legacy documents have no reviewStatus and count as published. There is
    // deliberately NO schema default (a default would be applied to legacy
    // documents when they are loaded); new documents that don't set it fail
    // closed to "pending_review" in the pre-validate hook below.
    reviewStatus: {
      type: String,
      enum: REVIEW_STATUSES,
    },

    review: {
      reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: undefined },
      reviewedAt: { type: Date, default: undefined },
      rejectionReason: { type: String, maxlength: 500, default: undefined },
    },

    // ---- Provenance (set by the ingestion pipeline only, never by users) --
    source: {
      kind: { type: String, enum: SOURCE_KINDS, default: undefined },
      channel: { type: String, lowercase: true, trim: true, default: undefined },
      messageId: { type: Number, default: undefined },
      url: { type: String, default: undefined, validate: urlValidator },
      postedAt: { type: Date, default: undefined },
    },

    // What the extractor produced and what the code checked. `redFlags`,
    // `linkClass`, `missing` and `droppedFields` are computed in plain code;
    // `modelNotes` is the LLM's own (advisory, untrusted) commentary.
    extraction: {
      model: { type: String, default: undefined },
      corrections: { type: [String], default: undefined },
      modelNotes: { type: [String], default: undefined },
      redFlags: { type: [String], default: undefined },
      linkClass: { type: String, enum: LINK_CLASSES, default: undefined },
      missing: { type: [String], default: undefined },
      droppedFields: { type: [String], default: undefined },
      post: { type: mongoose.Schema.Types.ObjectId, ref: "TelegramPost", default: undefined },
    },

    // Normalized hash of title|company|location used to link repeat postings.
    // Uniqueness is declared below as a partial unique index (jobs without a
    // dedupeKey are not constrained). Rejected jobs deliberately keep their key
    // so the same spam is not queued for review again.
    dedupeKey: { type: String, default: undefined },
  },
  {
    timestamps: true,
  }
);

// Fail closed: a NEW job that nobody explicitly published waits for review.
// Legacy documents (already stored without reviewStatus) are not "new", so
// they keep counting as published.
JobSchema.pre("validate", function () {
  if (this.isNew && !this.reviewStatus) {
    this.reviewStatus = "pending_review";
  }
});

// Matches the actual filters getJobs supports today (category/type/industry
// exact-match). Keyword search uses a regex $or, not $text, so no text index.
JobSchema.index({ category: 1 });
JobSchema.index({ employmentType: 1 });
JobSchema.index({ industry: 1 });
JobSchema.index({ reviewStatus: 1, createdAt: -1 });
// Public categories aggregate (published jobs grouped by category).
JobSchema.index({ reviewStatus: 1, category: 1 });
// Makes de-duplication atomic: two concurrent runs cannot both insert the same
// key. The pipeline treats E11000 on this index as "duplicate".
JobSchema.index(
  { dedupeKey: 1 },
  {
    name: "dedupeKey_unique_partial",
    unique: true,
    partialFilterExpression: { dedupeKey: { $type: "string" } },
  }
);
JobSchema.index({ "source.channel": 1, "source.messageId": 1 }, { sparse: true });

export const JOB_SALARY_CURRENCIES = SALARY_CURRENCIES;
export const JOB_SALARY_PERIODS = SALARY_PERIODS;
export const JOB_WORK_ARRANGEMENTS = WORK_ARRANGEMENTS;

const Job = mongoose.model("Job", JobSchema);

export default Job;
