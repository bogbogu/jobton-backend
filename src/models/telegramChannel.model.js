import mongoose from "mongoose";

// Telegram usernames: 5-32 chars, start with a letter, letters/digits/underscore.
// Stored lowercase. This pattern is the ONLY gate between an admin-typed
// value and the URL the poller fetches (https://t.me/s/<username>), so keep it strict.
export const TELEGRAM_USERNAME_PATTERN = /^[a-z][a-z0-9_]{4,31}$/;

const TelegramChannelSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: [true, "Channel username is required"],
      unique: true,
      lowercase: true,
      trim: true,
      match: [TELEGRAM_USERNAME_PATTERN, "Invalid Telegram channel username."],
    },

    // board    = one post is normally one vacancy
    // authored = editorial channel, one post may bundle several vacancies
    kind: {
      type: String,
      enum: ["board", "authored"],
      default: "board",
    },

    active: {
      type: Boolean,
      default: true,
    },

    // Highest Telegram message id stored so far; the poller stops paging
    // backwards once it reaches it.
    lastMessageId: {
      type: Number,
      default: 0,
    },

    lastPolledAt: {
      type: Date,
      default: null,
    },

    consecutiveFailures: {
      type: Number,
      default: 0,
    },

    // Short, sanitized reason only. Never store raw error objects here.
    lastError: {
      type: String,
      maxlength: 300,
      default: undefined,
    },

    addedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

const TelegramChannel = mongoose.model("TelegramChannel", TelegramChannelSchema);

export default TelegramChannel;
