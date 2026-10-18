import mongoose from "mongoose";

export const TELEGRAM_POST_STATUSES = [
  "new", // stored, not processed yet
  "extracted", // job created (see `job`)
  "not_job", // extractor says it is not a vacancy
  "duplicate", // repeat of an earlier post/job (see `job` when known)
  "skipped", // filtered out before any LLM call (empty, too short, caps)
  "failed", // extraction error (see `error`)
];

// Raw posts are kept only for a bounded time: they contain recruiters' phone
// numbers/emails (personal data under Nigeria's NDPR). A TTL index deletes
// them after RETENTION_DAYS; the Job keeps only the extracted fields.
export const TELEGRAM_POST_RETENTION_DAYS = 90;

const TelegramPostSchema = new mongoose.Schema(
  {
    channel: { type: String, required: true, lowercase: true, trim: true },
    messageId: { type: Number, required: true },
    postedAt: { type: Date, default: null },

    // Plain text, already cleaned of HTML/control chars and capped.
    text: { type: String, default: "", maxlength: 4000 },
    hasImage: { type: Boolean, default: false },

    // href values found in the post's anchors (used to cross-check links the LLM returns).
    links: {
      type: [{ _id: false, href: { type: String, maxlength: 2048 }, label: { type: String, maxlength: 300 } }],
      default: [],
    },

    // sha256 of normalized text; lets the pipeline skip reposts and
    // cross-channel copies BEFORE spending an LLM call.
    contentHash: { type: String, index: true },

    status: { type: String, enum: TELEGRAM_POST_STATUSES, default: "new", index: true },
    job: { type: mongoose.Schema.Types.ObjectId, ref: "Job", default: undefined },
    error: { type: String, maxlength: 300, default: undefined },

    fetchedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

TelegramPostSchema.index({ channel: 1, messageId: 1 }, { unique: true });
TelegramPostSchema.index(
  { fetchedAt: 1 },
  { expireAfterSeconds: TELEGRAM_POST_RETENTION_DAYS * 24 * 60 * 60 }
);

const TelegramPost = mongoose.model("TelegramPost", TelegramPostSchema);

export default TelegramPost;
