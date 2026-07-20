import mongoose from "mongoose";

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

    employmentType: {
      type: String,
      required: true,
      enum: [
        "Full-time",
        "Part-time",
        "Contract",
        "Internship",
        "Temporary",
        "Freelance",
      ],
    },

    salary: {
      type: String,
      default: "",
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
  },
  {
    timestamps: true,
  }
);

const Job = mongoose.model("Job", JobSchema);

export default Job;