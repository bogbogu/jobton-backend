import mongoose from "mongoose";
import {
  MAX_IMAGE_URLS_PER_POST,
  MAX_IMAGE_URL_CHARS,
  isAllowedTelegramImageUrl,
} from "../utils/telegramImageUrl.js";

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
// them after RETENTION_DAYS; the Job keeps only the extracted fields (and the
// allow-listed photo URLs, see `source.imageUrls`). Images themselves are never
// stored, and the URLs kept here are plain Telegram CDN links.
export const TELEGRAM_POST_RETENTION_DAYS = 90;

const TelegramPostSchema = new mongoose.Schema(
  {
    channel: { type: String, required: true, lowercase: true, trim: true },
    messageId: { type: Number, required: true },
    postedAt: { type: Date, default: null },

    // Plain text, already cleaned of HTML/control chars and capped.
    text: { type: String, default: "", maxlength: 4000 },
    hasImage: { type: Boolean, default: false },

    // https URLs of the post's photos on Telegram's CDN (at most 3). Anything
    // that is not on the allow-list is rejected by the schema, so a stored URL is
    // always safe to fetch. Posts stored before this field existed have none.
    imageUrls: {
      type: [{ type: String, maxlength: MAX_IMAGE_URL_CHARS }],
      default: [],
      validate: [
        {
          validator: (urls) => urls.length <= MAX_IMAGE_URLS_PER_POST,
          message: "A post keeps at most " + MAX_IMAGE_URLS_PER_POST + " image URLs.",
        },
        {
          validator: (urls) => urls.every(isAllowedTelegramImageUrl),
          message: "Image URLs must be https URLs on Telegram's CDN.",
        },
      ],
    },

    // Set once the picture(s) of this post were read. `imageHashes` are sha256 of
    // the downloaded bytes (the bytes themselves are never stored) so the same
    // flyer in another post is not paid for twice; `imageTranscript` is the
    // cleaned text the model copied from them ("" = nothing readable), kept so a
    // retried post does not download and transcribe again. Both go with the post
    // when its TTL expires.
    imageHashes: { type: [{ type: String, match: /^[0-9a-f]{64}$/ }], default: undefined, index: { sparse: true } },
    imageTranscript: { type: String, maxlength: 4000, default: undefined },

    // href values found in the post's anchors (used to cross-check links the LLM returns).
    links: {
      type: [{ _id: false, href: { type: String, maxlength: 2048 }, label: { type: String, maxlength: 300 } }],
      default: [],
    },

    // sha256 of normalized text; lets the pipeline skip reposts and
    // cross-channel copies BEFORE spending an LLM call.
    contentHash: { type: String, index: true },

    // Indexed through the compound { channel, status, messageId } below.
    status: { type: String, enum: TELEGRAM_POST_STATUSES, default: "new" },
    job: { type: mongoose.Schema.Types.ObjectId, ref: "Job", default: undefined },
    error: { type: String, maxlength: 300, default: undefined },

    // Transient LLM failures leave the post "new" and bump this; after
    // too many the pipeline gives up and marks it "failed".
    attempts: { type: Number, default: 0, min: 0 },

    fetchedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

TelegramPostSchema.index({ channel: 1, messageId: 1 }, { unique: true });
// Serves the per-channel "oldest new posts first" query of the extraction phase.
TelegramPostSchema.index({ channel: 1, status: 1, messageId: 1 });
TelegramPostSchema.index(
  { fetchedAt: 1 },
  { expireAfterSeconds: TELEGRAM_POST_RETENTION_DAYS * 24 * 60 * 60 }
);

const TelegramPost = mongoose.model("TelegramPost", TelegramPostSchema);

export default TelegramPost;
