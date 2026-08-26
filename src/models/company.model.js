import mongoose from "mongoose";
import { slugify } from "../utils/slugify.utils.js";

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
    },

    logoUrl: {
      type: String,
      default: "",
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
