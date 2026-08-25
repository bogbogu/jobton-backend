import mongoose from "mongoose";

const SALARY_CURRENCIES = ["NGN", "USD"];
const SALARY_PERIODS = ["hour", "month", "year"];
const WORK_ARRANGEMENTS = ["On-site", "Remote", "Hybrid"];

const JobSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, "Job title is required"],
      trim: true,
    },

    company: {
      type: String,
      required: [true, "Company name is required"],
      trim: true,
    },

    domain: {
      type: String,
      trim: true,
      default: "",
    },

    logoUrl: {
      type: String,
      default: "",
    },

    location: {
      type: String,
      required: [true, "Job location is required"],
      trim: true,
    },

    // Spelled "Full Time"/"Part Time" (not "Full-time"/"Part-time") to match
    // the frontend's existing jobTypeOptions wording exactly — the API
    // returns and filters on this value verbatim, no translation layer.
    employmentType: {
      type: String,
      required: true,
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
    salaryMin: {
      type: Number,
      required: [true, "Minimum salary is required"],
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
    category: {
      type: String,
      required: [true, "Category is required"],
      trim: true,
    },

    status: {
      type: [String],
      enum: ["featured", "verified", "urgent", "new"],
      default: [],
    },

    skills: {
      type: [String],
      default: [],
    },

    industry: {
      type: String,
      trim: true,
      default: "",
    },

    experience: {
      type: String,
      default: "",
    },

    qualification: {
      type: String,
      default: "",
    },

    description: {
      type: String,
      required: [true, "Job description is required"],
      trim: true,
    },

    responsibilities: {
      type: [String],
      default: [],
    },

    applicationLink: {
      type: String,
      required: [true, "Application link is required"],
      trim: true,
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
  },
  {
    timestamps: true,
  }
);

// Matches the actual filters getJobs supports today (category/type/industry
// exact-match). Keyword search uses a regex $or, not $text, so no text index.
JobSchema.index({ category: 1 });
JobSchema.index({ employmentType: 1 });
JobSchema.index({ industry: 1 });

export const JOB_SALARY_CURRENCIES = SALARY_CURRENCIES;
export const JOB_SALARY_PERIODS = SALARY_PERIODS;
export const JOB_WORK_ARRANGEMENTS = WORK_ARRANGEMENTS;

const Job = mongoose.model("Job", JobSchema);

export default Job;
