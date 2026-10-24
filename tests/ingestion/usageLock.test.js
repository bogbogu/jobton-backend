import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import IngestionLock, { acquireLease, releaseLease, renewLease } from "../../src/models/ingestionLock.model.js";
import IngestionUsage, { recordUsage, reserveLlmCall } from "../../src/models/ingestionUsage.model.js";

let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await Promise.all([IngestionLock.init(), IngestionUsage.init()]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await Promise.all([IngestionLock.deleteMany({}), IngestionUsage.deleteMany({})]);
});

describe("reserveLlmCall", () => {
  it("increments atomically until the cap and then refuses", async () => {
    const now = new Date("2026-10-18T10:00:00Z");
    expect(await reserveLlmCall(2, now)).toBe(true);
    expect(await reserveLlmCall(2, now)).toBe(true);
    expect(await reserveLlmCall(2, now)).toBe(false);
    expect(await reserveLlmCall(2, now)).toBe(false);

    const docs = await IngestionUsage.find({}).lean();
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ date: "2026-10-18", llmCalls: 2 });
  });

  it("never exceeds the cap under concurrency", async () => {
    const now = new Date("2026-10-18T10:00:00Z");
    const results = await Promise.all(Array.from({ length: 25 }, () => reserveLlmCall(10, now)));
    expect(results.filter(Boolean)).toHaveLength(10);
    expect((await IngestionUsage.findOne({}).lean()).llmCalls).toBe(10);
    expect(await IngestionUsage.countDocuments()).toBe(1);
  });

  it("uses a separate budget per UTC day", async () => {
    expect(await reserveLlmCall(1, new Date("2026-10-18T23:59:59Z"))).toBe(true);
    expect(await reserveLlmCall(1, new Date("2026-10-18T23:59:59Z"))).toBe(false);
    expect(await reserveLlmCall(1, new Date("2026-10-19T00:00:01Z"))).toBe(true);
  });

  it("refuses when the cap is zero or invalid", async () => {
    expect(await reserveLlmCall(0)).toBe(false);
    expect(await reserveLlmCall(Number.NaN)).toBe(false);
    expect(await IngestionUsage.countDocuments()).toBe(0);
  });
});

describe("recordUsage", () => {
  it("accumulates token counts for the day", async () => {
    const now = new Date("2026-10-18T10:00:00Z");
    await recordUsage({ input: 100, output: 20 }, now);
    await recordUsage({ input: 50, output: 5 }, now);
    expect(await IngestionUsage.findOne({ date: "2026-10-18" }).lean()).toMatchObject({
      inputTokens: 150,
      outputTokens: 25,
    });
  });
});

describe("leases", () => {
  it("lets only one holder in until the lease is released or expires", async () => {
    const t0 = new Date("2026-10-18T10:00:00Z");
    const first = await acquireLease("job", 60_000, t0);
    expect(first).toEqual(expect.any(String));
    expect(first.length).toBeGreaterThan(0);
    expect(await acquireLease("job", 60_000, new Date(t0.getTime() + 1000))).toBeNull();
    expect(await acquireLease("other", 60_000, t0)).toBeTruthy();

    expect(await releaseLease("job", first)).toBe(true);
    const second = await acquireLease("job", 60_000, new Date(t0.getTime() + 2000));
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);

    // expired lease (crashed run) can be taken over
    expect(await acquireLease("job", 60_000, new Date(t0.getTime() + 10 * 60_000))).toBeTruthy();
    expect(await IngestionLock.countDocuments({ name: "job" })).toBe(1);
  });

  it("allows exactly one winner among concurrent acquirers", async () => {
    const now = new Date();
    const results = await Promise.all(Array.from({ length: 10 }, () => acquireLease("race", 60_000, now)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("releases only for the owner: a stale holder cannot release a newer lease", async () => {
    const t0 = new Date("2026-10-18T10:00:00Z");
    const stale = await acquireLease("job", 60_000, t0);
    // the first lease expires and a second run takes over
    const current = await acquireLease("job", 60_000, new Date(t0.getTime() + 120_000));
    expect(current).toBeTruthy();

    expect(await releaseLease("job", stale)).toBe(false);
    expect(await releaseLease("job")).toBe(false);
    // still held by the current owner
    expect(await acquireLease("job", 60_000, new Date(t0.getTime() + 121_000))).toBeNull();

    expect(await releaseLease("job", current)).toBe(true);
    expect(await acquireLease("job", 60_000, new Date(t0.getTime() + 121_000))).toBeTruthy();
  });

  it("renews only for the owner and extends the expiry", async () => {
    const t0 = new Date("2026-10-18T10:00:00Z");
    const owner = await acquireLease("job", 60_000, t0);

    // without renewal the lease would be free at t0 + 90s
    expect(await renewLease("job", owner, 60_000, new Date(t0.getTime() + 50_000))).toBe(true);
    expect(await acquireLease("job", 60_000, new Date(t0.getTime() + 90_000))).toBeNull();
    expect(await acquireLease("job", 60_000, new Date(t0.getTime() + 111_000))).toBeTruthy();

    // that took the lease over: the old owner can no longer renew
    expect(await renewLease("job", owner, 60_000, new Date(t0.getTime() + 112_000))).toBe(false);
    expect(await renewLease("job", undefined, 60_000)).toBe(false);
    expect(await renewLease("missing", owner, 60_000)).toBe(false);
  });
});
