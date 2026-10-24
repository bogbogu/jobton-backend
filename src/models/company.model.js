import mongoose from "mongoose";
import { slugify } from "../utils/slugify.utils.js";
import { isSafeHttpUrl, isValidDomain } from "../utils/validators.utils.js";

// Rendered as <a href>/<img src> by the frontend: http(s) only. Empty = unset.
const urlValidator = {
  validator: (value) => value === undefined || value === null || value === "" || isSafeHttpUrl(value),
  message: "{PATH} must be an http(s) URL.",
};

const CompanySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Company name is required"],
      trim: true,
      unique: true,
    },

    // Derived from `name` (see the pre-save hook below) — kept as a real,
    // indexed field rather than computed on every read, since it's the
    // primary lookup key for GET /api/companies/:slug.
    slug: {
      type: String,
      unique: true,
      index: true,
    },

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

    description: {
      type: String,
      trim: true,
      default: "",
    },

    website: {
      type: String,
      trim: true,
      default: "",
      validate: urlValidator,
    },

    industry: {
      type: String,
      trim: true,
      default: "",
    },

    location: {
      type: String,
      trim: true,
      default: "",
    },

    // Optional: who added this company profile. Nullable so seed/admin-
    // created companies without a specific owner remain admin-only to edit.
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

CompanySchema.pre("save", function setSlugFromName() {
  if (this.isModified("name") || !this.slug) {
    this.slug = slugify(this.name);
  }
});

const Company = mongoose.model("Company", CompanySchema);

export default Company;
