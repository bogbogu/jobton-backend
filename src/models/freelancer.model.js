import mongoose from "mongoose";

const AVAILABILITY_OPTIONS = [
  "Available now",
  "Available next week",
  "Limited availability",
];

const HANDLE_PLATFORMS = ["LinkedIn", "X", "Instagram", "Portfolio", "WhatsApp"];

const FreelancerHandleSchema = new mongoose.Schema(
  {
    platform: {
      type: String,
      enum: HANDLE_PLATFORMS,
      required: true,
    },
    href: {
      type: String,
      required: true,
      trim: true,
    },
  },
  { _id: false }
);

const FreelancerSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Name is required"],
      trim: true,
    },

    role: {
      type: String,
      required: [true, "Role is required"],
      trim: true,
    },

    category: {
      type: String,
      required: [true, "Category is required"],
      trim: true,
    },

    location: {
      type: String,
      required: [true, "Location is required"],
      trim: true,
    },

    availability: {
      type: String,
      enum: AVAILABILITY_OPTIONS,
      default: "Available now",
    },

    hourlyRate: {
      type: String,
      required: [true, "Hourly rate is required"],
      trim: true,
    },

    yearsExperience: {
      type: Number,
      required: true,
      min: 0,
    },

    projectsCompleted: {
      type: Number,
      default: 0,
      min: 0,
    },

    rating: {
      type: Number,
      default: 0,
      min: 0,
      max: 5,
    },

    bio: {
      type: String,
      required: [true, "Bio is required"],
      trim: true,
    },

    skills: {
      type: [String],
      default: [],
    },

    email: {
      type: String,
      required: [true, "Email is required"],
      trim: true,
      lowercase: true,
    },

    phone: {
      type: String,
      required: [true, "Phone is required"],
      trim: true,
    },

    handles: {
      type: [FreelancerHandleSchema],
      default: [],
    },

    // Optional: the User account managing this profile, if any. Profiles
    // added by an admin on someone's behalf can leave this unset.
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Matches the exact-match category filter getFreelancers supports today.
// Search (`q`) uses a regex $or, not $text, so no text index.
FreelancerSchema.index({ category: 1 });

export const FREELANCER_AVAILABILITY_OPTIONS = AVAILABILITY_OPTIONS;
export const FREELANCER_HANDLE_PLATFORMS = HANDLE_PLATFORMS;

const Freelancer = mongoose.model("Freelancer", FreelancerSchema);

export default Freelancer;
