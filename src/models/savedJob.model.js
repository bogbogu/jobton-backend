import mongoose from "mongoose";

const SavedJobSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    job: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Job",
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

// A user can only save a given job once; also the natural index for both
// "does this user have this job saved" and "list this user's saved jobs".
SavedJobSchema.index({ user: 1, job: 1 }, { unique: true });

const SavedJob = mongoose.model("SavedJob", SavedJobSchema);

export default SavedJob;
