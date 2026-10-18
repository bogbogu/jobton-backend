import mongoose from "mongoose";
import Job from "../models/job.model.js";
import TelegramChannel, { TELEGRAM_USERNAME_PATTERN } from "../models/telegramChannel.model.js";
import { REVIEW_STATUSES } from "../utils/jobVisibility.js";

const CHANNEL_KINDS = ["board", "authored"];

const isObjectIdString = (value) =>
  typeof value === "string" &&
  /^[0-9a-fA-F]{24}$/.test(value) &&
  mongoose.Types.ObjectId.isValid(value);

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

// Accepts "@name", "name", "https://t.me/name", "t.me/name" (also telegram.me)
// and returns the bare lowercase username candidate. The caller must still
// check it against TELEGRAM_USERNAME_PATTERN.
export const normalizeChannelUsername = (raw) => {
  if (typeof raw !== "string") return "";

  return raw
    .trim()
    .toLowerCase()
    .replace(/^(https?:\/\/)?(www\.)?(t|telegram)\.me\//, "")
    .replace(/^@/, "")
    .replace(/\/+$/, "");
};

// One aggregate for all channels: { [channel]: { pending_review, published, rejected } }.
// Legacy jobs without reviewStatus count as published.
const getJobCountsByChannel = async (usernames) => {
  const counts = {};

  for (const username of usernames) {
    counts[username] = Object.fromEntries(REVIEW_STATUSES.map((status) => [status, 0]));
  }

  if (usernames.length === 0) return counts;

  const rows = await Job.aggregate([
    { $match: { "source.channel": { $in: usernames } } },
    {
      $group: {
        _id: {
          channel: "$source.channel",
          status: { $ifNull: ["$reviewStatus", "published"] },
        },
        count: { $sum: 1 },
      },
    },
  ]);

  for (const row of rows) {
    if (counts[row._id.channel] && row._id.status in counts[row._id.channel]) {
      counts[row._id.channel][row._id.status] = row.count;
    }
  }

  return counts;
};

const serializeChannel = (channel, jobCounts) => ({
  id: channel._id.toString(),
  username: channel.username,
  kind: channel.kind,
  active: channel.active,
  lastPolledAt: channel.lastPolledAt || null,
  lastMessageId: channel.lastMessageId,
  consecutiveFailures: channel.consecutiveFailures,
  lastError: channel.lastError || null,
  addedBy: channel.addedBy ? channel.addedBy.toString() : null,
  createdAt: channel.createdAt,
  updatedAt: channel.updatedAt,
  jobCounts: jobCounts || Object.fromEntries(REVIEW_STATUSES.map((status) => [status, 0])),
});

const serializeWithCounts = async (channel) => {
  const counts = await getJobCountsByChannel([channel.username]);
  return serializeChannel(channel, counts[channel.username]);
};

export const listChannels = async (req, res) => {
  try {
    const channels = await TelegramChannel.find().sort({ username: 1 });
    const counts = await getJobCountsByChannel(channels.map((channel) => channel.username));

    return res.status(200).json({
      message: "Channels retrieved successfully.",
      channels: channels.map((channel) => serializeChannel(channel, counts[channel.username])),
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

export const createChannel = async (req, res) => {
  try {
    const body = req.body || {};
    const username = normalizeChannelUsername(body.username);

    if (!TELEGRAM_USERNAME_PATTERN.test(username)) {
      return res.status(400).json({
        message:
          "Invalid Telegram username. Use 5-32 letters, digits or underscores, starting with a letter.",
        error: "INVALID_USERNAME",
      });
    }

    let kind = "board";
    if (body.kind !== undefined) {
      if (typeof body.kind !== "string" || !CHANNEL_KINDS.includes(body.kind)) {
        return res.status(400).json({
          message: `kind must be one of: ${CHANNEL_KINDS.join(", ")}.`,
          error: "INVALID_KIND",
        });
      }
      kind = body.kind;
    }

    if (await TelegramChannel.exists({ username })) {
      return res.status(409).json({
        message: "This channel is already added.",
        error: "DUPLICATE_CHANNEL",
      });
    }

    let channel;
    try {
      channel = await TelegramChannel.create({ username, kind, addedBy: req.user._id });
    } catch (error) {
      // Lost a race against a concurrent create of the same username.
      if (error.code === 11000) {
        return res.status(409).json({
          message: "This channel is already added.",
          error: "DUPLICATE_CHANNEL",
        });
      }
      throw error;
    }

    console.info(`[admin-audit] action=channel-create admin=${req.user._id} channel=${channel._id}`);

    return res.status(201).json({
      message: "Channel added.",
      channel: await serializeWithCounts(channel),
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

export const updateChannel = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isObjectIdString(id)) {
      return res.status(404).json({ message: "Channel not found." });
    }

    const body = req.body || {};
    const set = {};

    if (hasOwn(body, "active")) {
      if (typeof body.active !== "boolean") {
        return res.status(400).json({
          message: "active must be a boolean.",
          error: "INVALID_ACTIVE",
        });
      }
      set.active = body.active;
    }

    if (hasOwn(body, "kind")) {
      if (typeof body.kind !== "string" || !CHANNEL_KINDS.includes(body.kind)) {
        return res.status(400).json({
          message: `kind must be one of: ${CHANNEL_KINDS.join(", ")}.`,
          error: "INVALID_KIND",
        });
      }
      set.kind = body.kind;
    }

    if (Object.keys(set).length === 0) {
      return res.status(400).json({
        message: "Provide active and/or kind.",
        error: "NO_CHANGES",
      });
    }

    const channel = await TelegramChannel.findByIdAndUpdate(
      id,
      { $set: set },
      { returnDocument: "after", runValidators: true }
    );

    if (!channel) {
      return res.status(404).json({ message: "Channel not found." });
    }

    console.info(`[admin-audit] action=channel-update admin=${req.user._id} channel=${channel._id}`);

    return res.status(200).json({
      message: "Channel updated.",
      channel: await serializeWithCounts(channel),
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Internal server error." });
  }
};
