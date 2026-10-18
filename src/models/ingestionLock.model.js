import { randomBytes } from "node:crypto";
import mongoose from "mongoose";

// A named lease so two overlapping cron runs cannot both ingest. The unique
// `name` plus a conditional upsert makes acquisition atomic. `owner` is a
// random token only the holder knows: release and renewal require it, so a run
// whose lease expired (and was taken over) can never release or extend the new
// holder's lease.
const IngestionLockSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  leaseUntil: { type: Date, required: true },
  owner: { type: String },
});

const IngestionLock = mongoose.model("IngestionLock", IngestionLockSchema);

const DUPLICATE_KEY = 11000;

// Returns the owner token (a non-empty string, truthy) when this caller now
// holds the lease, or null when someone else holds it. An unexpired lease held
// by someone else makes the filter miss; the resulting upsert-insert then hits
// the unique index (duplicate key) and we report "not acquired". A crashed run
// never blocks forever: its lease simply expires.
export async function acquireLease(name, ttlMs, now = new Date()) {
  const owner = randomBytes(16).toString("hex");

  try {
    await IngestionLock.findOneAndUpdate(
      { name, leaseUntil: { $lt: now } },
      { $set: { leaseUntil: new Date(now.getTime() + ttlMs), owner } },
      { upsert: true }
    );
    return owner;
  } catch (error) {
    if (error?.code === DUPLICATE_KEY) return null;
    throw error;
  }
}

// Extends the lease, but only for the current owner. Returns false when the
// lease is no longer ours (taken over, or removed).
export async function renewLease(name, owner, ttlMs, now = new Date()) {
  if (!owner) return false;

  const result = await IngestionLock.updateOne(
    { name, owner },
    { $set: { leaseUntil: new Date(now.getTime() + ttlMs) } }
  );
  return result.matchedCount > 0;
}

// Releases the lease only when `owner` still holds it. Returns whether it did.
export async function releaseLease(name, owner) {
  if (!owner) return false;

  const result = await IngestionLock.updateOne({ name, owner }, { $set: { leaseUntil: new Date(0) } });
  return result.matchedCount > 0;
}

export default IngestionLock;
