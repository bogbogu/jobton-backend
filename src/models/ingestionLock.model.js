import mongoose from "mongoose";

// A named lease so two overlapping cron runs cannot both ingest. The unique
// `name` plus a conditional upsert makes acquisition atomic.
const IngestionLockSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  leaseUntil: { type: Date, required: true },
});

const IngestionLock = mongoose.model("IngestionLock", IngestionLockSchema);

const DUPLICATE_KEY = 11000;

// Returns true when this caller now holds the lease. An unexpired lease held
// by someone else makes the filter miss; the resulting upsert-insert then hits
// the unique index (duplicate key) and we report "not acquired". A crashed run
// never blocks forever: its lease simply expires.
export async function acquireLease(name, ttlMs, now = new Date()) {
  try {
    await IngestionLock.findOneAndUpdate(
      { name, leaseUntil: { $lt: now } },
      { $set: { leaseUntil: new Date(now.getTime() + ttlMs) } },
      { upsert: true }
    );
    return true;
  } catch (error) {
    if (error?.code === DUPLICATE_KEY) return false;
    throw error;
  }
}

export async function releaseLease(name) {
  await IngestionLock.updateOne({ name }, { $set: { leaseUntil: new Date(0) } });
}

export default IngestionLock;
