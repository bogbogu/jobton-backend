import mongoose from "mongoose";

// One document per UTC day. The unique `date` plus an atomic conditional
// increment is what makes the daily LLM-call cap a real limit even if two
// ingestion processes overlap.
const IngestionUsageSchema = new mongoose.Schema(
  {
    date: { type: String, required: true, unique: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    llmCalls: { type: Number, default: 0, min: 0 },
    inputTokens: { type: Number, default: 0, min: 0 },
    outputTokens: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

const IngestionUsage = mongoose.model("IngestionUsage", IngestionUsageSchema);

const DUPLICATE_KEY = 11000;

export const utcDay = (now = new Date()) => now.toISOString().slice(0, 10);

// Atomically takes one LLM call from today's budget. Returns true when the
// call may be made, false when the cap is already reached.
//
// The upsert filter is { date, llmCalls < cap }. When today's document exists
// and is at the cap, the filter matches nothing and the upsert tries to INSERT
// a second document for the same date; the unique index rejects that with a
// duplicate-key error, which here means "cap reached" (or a lost creation race,
// handled by one retry without upsert).
export async function reserveLlmCall(cap, now = new Date()) {
  if (!Number.isFinite(cap) || cap <= 0) return false;

  const date = utcDay(now);
  const filter = { date, llmCalls: { $lt: cap } };
  const update = { $inc: { llmCalls: 1 } };

  try {
    await IngestionUsage.findOneAndUpdate(filter, update, { upsert: true });
    return true;
  } catch (error) {
    if (error?.code !== DUPLICATE_KEY) throw error;
  }

  const retried = await IngestionUsage.findOneAndUpdate(filter, update);
  return retried !== null;
}

// LLM calls already reserved today (0 when there is no document yet).
export async function getLlmCallsToday(now = new Date()) {
  const doc = await IngestionUsage.findOne({ date: utcDay(now) }, { llmCalls: 1 }).lean();
  return doc?.llmCalls || 0;
}

// Adds token counts to today's document.
export async function recordUsage({ input = 0, output = 0 } = {}, now = new Date()) {
  const date = utcDay(now);
  const update = {
    $inc: {
      inputTokens: Math.max(0, Number(input) || 0),
      outputTokens: Math.max(0, Number(output) || 0),
    },
  };

  try {
    await IngestionUsage.updateOne({ date }, update, { upsert: true });
  } catch (error) {
    if (error?.code !== DUPLICATE_KEY) throw error;
    await IngestionUsage.updateOne({ date }, update);
  }
}

export default IngestionUsage;
