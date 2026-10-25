import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Job from "../../src/models/job.model.js";
import TelegramPost from "../../src/models/telegramPost.model.js";
import IngestionUsage from "../../src/models/ingestionUsage.model.js";
import { computeDedupeKey } from "../../src/services/ingestion/dedupe.js";
import {
  applyTargetError,
  backfillCallCeiling,
  backfillCandidateFilter,
  buildSectionsUpdate,
  matchExtractedJob,
  parseBackfillArgs,
  runSectionsBackfill,
} from "../../src/services/ingestion/backfillSections.js";
import { testConfig } from "./helpers.js";

let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await Promise.all([Job.init(), TelegramPost.init(), IngestionUsage.init()]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await Promise.all([Job.deleteMany({}), TelegramPost.deleteMany({}), IngestionUsage.deleteMany({})]);
});

let sequence = 0;
const POST_TEXT = "Acme Nigeria Ltd is hiring an Accountant in Lagos. Requirements: Excel. Benefits: HMO. Email careers@acme.com";

const makePost = (overrides = {}) => {
  sequence += 1;
  return TelegramPost.create({
    channel: "tohire_ng",
    messageId: sequence,
    text: POST_TEXT,
    links: [],
    status: "extracted",
    ...overrides,
  });
};

// A pending Telegram job as the pipeline created it before the sections existed.
const makeJob = async (post, overrides = {}) => {
  sequence += 1;
  const base = { title: `Accountant ${sequence}`, company: "Acme Nigeria Ltd", location: "Lagos" };
  const fields = { ...base, ...overrides };
  return Job.create({
    description: "An accountant role.",
    category: "Finance",
    applyEmail: "careers@acme.com",
    reviewStatus: "pending_review",
    source: { kind: "telegram", channel: "tohire_ng", messageId: sequence },
    extraction: { post: post?._id },
    dedupeKey: computeDedupeKey(fields),
    ...fields,
  });
};

const extractedJob = (job, sections = {}) => ({
  title: job.title,
  company: job.company,
  location: job.location,
  description: "An accountant role.",
  aboutCompany: "",
  requirements: ["Excel"],
  benefits: ["HMO"],
  ...sections,
});

const okExtraction = (jobs) => ({
  jobs,
  isJobPost: true,
  notJobReason: undefined,
  modelNotes: [],
  usage: { input: 100, output: 50 },
});

// An extractor that returns the same sections for whichever job it is asked about.
const fakeExtract = (respond) => vi.fn(async (args) => respond(args));

const config = (overrides = {}) => testConfig(overrides);
const silent = () => vi.fn();

const run = ({ config: configOverrides, log = silent(), ...options } = {}) =>
  runSectionsBackfill({ ...options, config: config(configOverrides), log });

describe("backfillCandidateFilter", () => {
  it("only selects pending Telegram jobs whose three sections are all empty", async () => {
    const post = await makePost();
    const wanted = await makeJob(post);
    await makeJob(post, { title: "Has about", aboutCompany: "Already there." });
    await makeJob(post, { title: "Has requirements", requirements: ["Excel"] });
    await makeJob(post, { title: "Has benefits", benefits: ["HMO"] });
    await makeJob(post, { title: "Published", reviewStatus: "published" });
    await makeJob(post, { title: "Rejected", reviewStatus: "rejected" });
    // Not from Telegram.
    await Job.create({ title: "Posted by hand", description: "d", company: "c", location: "l", category: "x", employmentType: "Contract", salaryMin: 1, applicationLink: "https://acme.com/a", reviewStatus: "pending_review" });
    // A document stored before the fields existed.
    const { insertedId } = await Job.collection.insertOne({
      title: "Old",
      description: "d",
      reviewStatus: "pending_review",
      source: { kind: "telegram", channel: "tohire_ng", messageId: 1 },
      createdAt: new Date(),
    });

    const found = await Job.find(backfillCandidateFilter()).lean();

    expect(found.map((job) => String(job._id)).sort()).toEqual([String(wanted._id), String(insertedId)].sort());
  });
});

describe("jobs a human has touched", () => {
  it("are not selected: reviewed (review.reviewedBy) or restored (review.restoredAt)", async () => {
    const post = await makePost();
    const wanted = await makeJob(post, { title: "Untouched" });
    await makeJob(post, { title: "Reviewed", review: { reviewedBy: new mongoose.Types.ObjectId() } });
    await makeJob(post, { title: "Restored", review: { restoredAt: new Date(), restoredFromStatus: "rejected" } });
    await makeJob(post, { title: "Restored by someone", review: { restoredBy: new mongoose.Types.ObjectId(), restoredAt: new Date() } });

    const found = await Job.find(backfillCandidateFilter()).lean();

    expect(found.map((job) => String(job._id))).toEqual([String(wanted._id)]);
  });

  it("are left alone even if they become touched while the model is running", async () => {
    const job = await makeJob(await makePost());
    const extract = vi.fn(async () => {
      await Job.updateOne({ _id: job._id }, { $set: { "review.restoredAt": new Date() } });
      return okExtraction([extractedJob(job)]);
    });

    const summary = await run({ apply: true, extract });

    expect(summary).toMatchObject({ updated: 0, changedMeanwhile: 1 });
    expect((await Job.findById(job._id)).requirements).toEqual([]);
  });

  it("are not counted as candidates in a dry run either", async () => {
    await makeJob(await makePost(), { review: { reviewedBy: new mongoose.Types.ObjectId() } });

    const summary = await run({});

    expect(summary.candidates).toBe(0);
  });
});

describe("daily budget: --max-calls and the 20% headroom", () => {
  it("keeps 20% of the daily cap for ingestion", () => {
    expect(backfillCallCeiling(300)).toBe(240);
    expect(backfillCallCeiling(10)).toBe(8);
    expect(backfillCallCeiling(3)).toBe(2);
    expect(backfillCallCeiling(1)).toBe(0);
    expect(backfillCallCeiling(0)).toBe(0);
    expect(backfillCallCeiling(Number.NaN)).toBe(0);
  });

  it("refuses to call once what is left would drop below 20% of the cap", async () => {
    await makeJob(await makePost());
    await IngestionUsage.create({ date: new Date().toISOString().slice(0, 10), llmCalls: 8 });
    const extract = vi.fn();

    const summary = await run({ apply: true, extract, config: { dailyLlmCap: 10 } });

    expect(extract).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ llmCalls: 0, stoppedByCap: true, updated: 0 });
    expect((await IngestionUsage.findOne({}).lean()).llmCalls).toBe(8);
  });

  it("never lets today's counter go past 80% of the cap, across many posts", async () => {
    for (let index = 0; index < 6; index += 1) {
      await makeJob(await makePost({ text: `${POST_TEXT} ${index}` }), { title: `Job ${index}`, createdAt: new Date(2026, 0, index + 1) });
    }
    const extract = vi.fn(async ({ text }) => okExtraction([extractedJob(await Job.findOne({ title: `Job ${text.slice(-1)}` }))]));

    const summary = await run({ apply: true, extract, config: { dailyLlmCap: 5 } });

    // floor(5 * 0.8) = 4 calls; the fifth would leave less than 20%.
    expect(summary).toMatchObject({ llmCalls: 4, updated: 4, stoppedByCap: true });
    expect((await IngestionUsage.findOne({}).lean()).llmCalls).toBe(4);
  });

  it("stops after --max-calls calls", async () => {
    for (let index = 0; index < 4; index += 1) {
      await makeJob(await makePost({ text: `${POST_TEXT} ${index}` }), { title: `Job ${index}`, createdAt: new Date(2026, 0, index + 1) });
    }
    const extract = vi.fn(async ({ text }) => okExtraction([extractedJob(await Job.findOne({ title: `Job ${text.slice(-1)}` }))]));

    const summary = await run({ apply: true, extract, maxCalls: 2 });

    expect(extract).toHaveBeenCalledTimes(2);
    expect(summary).toMatchObject({ llmCalls: 2, updated: 2, stoppedByMaxCalls: true, stoppedByCap: false });
    expect((await Job.findOne({ title: "Job 2" })).requirements).toEqual([]);
  });

  it("does not count jobs served from the same post's single call against --max-calls", async () => {
    const post = await makePost();
    const first = await makeJob(post, { title: "Accountant", createdAt: new Date("2026-01-01") });
    const second = await makeJob(post, { title: "Cashier", createdAt: new Date("2026-01-02") });
    const extract = fakeExtract(() => okExtraction([extractedJob(first), extractedJob(second)]));

    const summary = await run({ apply: true, extract, maxCalls: 1 });

    expect(summary).toMatchObject({ llmCalls: 1, updated: 2, stoppedByMaxCalls: false });
  });

  it("reports what is left, in a dry run too", async () => {
    await IngestionUsage.create({ date: new Date().toISOString().slice(0, 10), llmCalls: 50 });

    const summary = await run({ config: { dailyLlmCap: 100 } });

    expect(summary).toMatchObject({ llmCallsLeftToday: 50, llmCallsAvailableToBackfill: 30 });
  });
});

describe("command line", () => {
  it("parses the flags", () => {
    expect(parseBackfillArgs([])).toEqual({ apply: false, limit: undefined, maxCalls: undefined, yesDb: undefined });
    expect(parseBackfillArgs(["--apply", "--yes-db=jobton", "--limit", "50", "--max-calls=7"])).toEqual({
      apply: true,
      limit: 50,
      maxCalls: 7,
      yesDb: "jobton",
    });
    expect(parseBackfillArgs(["--limit=3"]).limit).toBe(3);
  });

  it("rejects unknown flags and bad numbers", () => {
    for (const args of [
      ["--bogus"],
      ["--apply=1"],
      ["--limit"],
      ["--limit", "0"],
      ["--limit", "-1"],
      ["--limit=abc"],
      ["--max-calls"],
      ["--max-calls", "1.5"],
      ["--yes-db"],
      ["--yes-db="],
      ["--yes-db", "jobton"],
      ["positional"],
    ]) {
      expect(() => parseBackfillArgs(args), args.join(" ")).toThrow();
    }
  });

  it("only lets --apply write to the database it was told to expect", () => {
    expect(applyTargetError({ apply: false, yesDb: undefined, dbName: "prod" })).toBeNull();
    expect(applyTargetError({ apply: true, yesDb: "prod", dbName: "prod" })).toBeNull();
    expect(applyTargetError({ apply: true, yesDb: undefined, dbName: "prod" })).toMatch(/--yes-db/);
    expect(applyTargetError({ apply: true, yesDb: "staging", dbName: "prod" })).toMatch(/does not match/);
    expect(applyTargetError({ apply: true, yesDb: "Prod", dbName: "prod" })).toMatch(/does not match/);
  });
});

describe("matchExtractedJob and buildSectionsUpdate", () => {
  const job = { title: "Accountant", company: "Acme", location: "Lagos", dedupeKey: computeDedupeKey({ title: "Accountant", company: "Acme", location: "Lagos" }) };

  it("matches by dedupeKey first, then by an unambiguous title, then by a single job per post", () => {
    const other = { title: "Cashier", company: "Acme", location: "Lagos" };
    const same = { title: "Accountant", company: "Acme", location: "Lagos" };

    expect(matchExtractedJob(job, [other, same])).toBe(same);
    expect(matchExtractedJob({ ...job, dedupeKey: "different" }, [other, { ...same, company: "ACME Ltd" }])).toMatchObject({ title: "Accountant" });
    expect(matchExtractedJob({ ...job, dedupeKey: "different", title: "Edited" }, [other], { storedJobsForPost: 1 })).toBe(other);
  });

  it("does not guess when it is unclear which vacancy is meant", () => {
    const a = { title: "Cashier" };
    const b = { title: "Driver" };

    expect(matchExtractedJob({ ...job, dedupeKey: "x" }, [a, b])).toBeNull();
    expect(matchExtractedJob({ ...job, dedupeKey: "x", title: "Edited" }, [a], { storedJobsForPost: 2 })).toBeNull();
    expect(matchExtractedJob(job, [])).toBeNull();
  });

  it("builds an update from the three sections and the domain only", () => {
    const set = buildSectionsUpdate(
      { domain: "", applicationLink: "https://careers.acme.com/1", company: "Acme", title: "ignored" },
      { aboutCompany: "About.", requirements: ["R"], benefits: [], title: "ignored too", salaryMin: 5 }
    );

    expect(set).toEqual({ aboutCompany: "About.", requirements: ["R"], domain: "careers.acme.com" });
  });

  it("never replaces an existing domain and returns null when there is nothing to add", () => {
    expect(buildSectionsUpdate({ domain: "mine.com", applyEmail: "hr@acme.com" }, { requirements: [], benefits: [], aboutCompany: "" })).toBeNull();
    expect(buildSectionsUpdate({ domain: "mine.com" }, { benefits: ["HMO"] })).toEqual({ benefits: ["HMO"] });
    expect(buildSectionsUpdate({ domain: "", applyEmail: "someone@gmail.com" }, {})).toBeNull();
  });
});

describe("runSectionsBackfill: dry run", () => {
  it("only counts: no LLM calls, no usage, no writes", async () => {
    const post = await makePost();
    await makeJob(post);
    await makeJob(post);
    await makeJob(null, { title: "No post" });
    await makeJob(await makePost({ text: "" }), { title: "Empty post" });
    const extract = fakeExtract(() => {
      throw new Error("must not be called");
    });
    const before = await Job.find({}).sort({ _id: 1 }).lean();

    const summary = await run({ extract });

    expect(extract).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ dryRun: true, candidates: 4, withPost: 2, noPost: 2, llmCalls: 0, updated: 0 });
    expect(summary.llmCallsLeftToday).toBe(300);
    expect(await IngestionUsage.countDocuments()).toBe(0);
    expect(await Job.find({}).sort({ _id: 1 }).lean()).toEqual(before);
  });

  it("is the default when apply is not given", async () => {
    const post = await makePost();
    const job = await makeJob(post);
    const extract = fakeExtract(() => okExtraction([extractedJob(job)]));

    await runSectionsBackfill({ extract, config: config(), log: silent() });

    expect(extract).not.toHaveBeenCalled();
    expect((await Job.findById(job._id)).requirements).toEqual([]);
  });
});

describe("runSectionsBackfill: apply", () => {
  it("sets only the three sections and the domain, never anything else", async () => {
    const post = await makePost();
    // An admin already corrected several fields on the pending job.
    const job = await makeJob(post, {
      title: "Admin Edited Title",
      description: "Rewritten by an admin.",
      industry: "Fintech",
      status: ["verified"],
      salaryMin: 123456,
      applicationLink: "https://careers.acme.com/jobs/1",
    });
    await Job.updateOne({ _id: job._id }, { $set: { "review.rejectionReason": "kept", experience: "5 years" } });
    const before = (await Job.findById(job._id).lean());

    const extract = fakeExtract(() =>
      okExtraction([
        {
          ...extractedJob(job),
          title: "Model Title",
          description: "Model description",
          aboutCompany: "Acme is a payments company.",
          requirements: ["Excel", "Degree"],
          benefits: ["HMO"],
          salaryMin: 999,
        },
      ])
    );

    const summary = await run({ apply: true, extract });

    expect(summary).toMatchObject({ dryRun: false, candidates: 1, llmCalls: 1, updated: 1, failed: 0 });
    const after = await Job.findById(job._id).lean();
    const { aboutCompany, requirements, benefits, domain, updatedAt, ...rest } = after;
    const { aboutCompany: a0, requirements: r0, benefits: b0, domain: d0, updatedAt: u0, ...restBefore } = before;
    expect(rest).toEqual(restBefore);
    expect({ aboutCompany, requirements, benefits, domain }).toEqual({
      aboutCompany: "Acme is a payments company.",
      requirements: ["Excel", "Degree"],
      benefits: ["HMO"],
      domain: "careers.acme.com",
    });
    expect(after.title).toBe("Admin Edited Title");
    expect(after.description).toBe("Rewritten by an admin.");
    expect(after.status).toEqual(["verified"]);
    // The change is visible to an open review of the older version (it goes stale).
    expect(updatedAt.getTime()).toBeGreaterThan(u0.getTime());
  });

  it("passes the stored post text to the extractor and records usage", async () => {
    const post = await makePost({ links: [{ href: "https://careers.acme.com/1", label: "Apply" }] });
    const job = await makeJob(post);
    const extract = fakeExtract(() => okExtraction([extractedJob(job)]));

    await run({ apply: true, extract });

    expect(extract).toHaveBeenCalledTimes(1);
    expect(extract.mock.calls[0][0]).toMatchObject({
      text: POST_TEXT,
      links: [{ href: "https://careers.acme.com/1", label: "Apply" }],
      model: "claude-haiku-5-5",
    });
    const usage = await IngestionUsage.findOne({}).lean();
    expect(usage).toMatchObject({ llmCalls: 1, inputTokens: 100, outputTokens: 50 });
  });

  it("works oldest first and respects --limit", async () => {
    // Created newest first, so the oldest jobs are the last ones made.
    for (let index = 0; index < 4; index += 1) {
      const post = await makePost({ text: `${POST_TEXT} Job${index}` });
      await makeJob(post, { title: `Job ${index}`, createdAt: new Date(2026, 0, 10 - index) });
    }
    const extract = vi.fn(async ({ text }) => {
      const job = await Job.findOne({ title: `Job ${text.slice(-1)}` });
      return okExtraction([extractedJob(job)]);
    });

    const summary = await run({ apply: true, extract, limit: 2 });

    expect(summary).toMatchObject({ candidates: 2, updated: 2 });
    expect(extract).toHaveBeenCalledTimes(2);
    const done = await Job.find({ requirements: "Excel" }).lean();
    expect(done.map((job) => job.title).sort()).toEqual(["Job 2", "Job 3"]);
  });

  it("processes in createdAt order", async () => {
    const newer = await makeJob(await makePost({ text: `${POST_TEXT} newer` }), { title: "Newer", createdAt: new Date("2026-03-01") });
    const older = await makeJob(await makePost({ text: `${POST_TEXT} older` }), { title: "Older", createdAt: new Date("2026-01-01") });
    const seen = [];
    const extract = vi.fn(async ({ text }) => {
      seen.push(text.endsWith("older") ? "older" : "newer");
      return okExtraction([extractedJob(text.endsWith("older") ? older : newer)]);
    });

    await run({ apply: true, extract });

    expect(seen).toEqual(["older", "newer"]);
  });

  it("stops cleanly when the shared daily cap is reached", async () => {
    for (let index = 0; index < 3; index += 1) {
      const post = await makePost({ text: `${POST_TEXT} ${index}` });
      await makeJob(post, { title: `Job ${index}`, createdAt: new Date(2026, 0, index + 1) });
    }
    const extract = vi.fn(async ({ text }) => {
      const job = await Job.findOne({ title: `Job ${text.slice(-1)}` });
      return okExtraction([extractedJob(job)]);
    });
    // Six calls were already used today by the ingestion pipeline; the backfill may
    // go up to 80% of the cap (8 of 10), so it gets two more.
    await IngestionUsage.create({ date: new Date().toISOString().slice(0, 10), llmCalls: 6 });

    const summary = await run({ apply: true, extract, config: { dailyLlmCap: 10 } });

    expect(summary).toMatchObject({ llmCalls: 2, updated: 2, stoppedByCap: true, abortedByErrors: false });
    expect(extract).toHaveBeenCalledTimes(2);
    expect((await IngestionUsage.findOne({}).lean()).llmCalls).toBe(8);
    // The newest job was not reached and is untouched.
    expect((await Job.findOne({ title: "Job 2" })).requirements).toEqual([]);
  });

  it("makes no call at all when the cap is already used up", async () => {
    await makeJob(await makePost());
    await IngestionUsage.create({ date: new Date().toISOString().slice(0, 10), llmCalls: 5 });
    const extract = vi.fn();

    const summary = await run({ apply: true, extract, config: { dailyLlmCap: 5 } });

    expect(extract).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ stoppedByCap: true, llmCalls: 0, updated: 0 });
  });

  it("spends one call for several jobs that came from the same post", async () => {
    const post = await makePost();
    const first = await makeJob(post, { title: "Accountant", createdAt: new Date("2026-01-01") });
    const second = await makeJob(post, { title: "Cashier", createdAt: new Date("2026-01-02") });
    const extract = fakeExtract(() =>
      okExtraction([
        extractedJob(second, { requirements: ["Cash handling"], benefits: [] }),
        extractedJob(first, { requirements: ["Excel"], benefits: ["HMO"] }),
      ])
    );

    const summary = await run({ apply: true, extract });

    expect(extract).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ llmCalls: 1, updated: 2 });
    expect((await Job.findById(first._id)).requirements).toEqual(["Excel"]);
    expect((await Job.findById(second._id)).requirements).toEqual(["Cash handling"]);
  });

  it("leaves a job alone when the extraction does not clearly match it", async () => {
    const post = await makePost();
    const first = await makeJob(post, { title: "Accountant" });
    await makeJob(post, { title: "Cashier" });
    const extract = fakeExtract(() => okExtraction([{ title: "Driver", company: "Other", location: "Abuja", requirements: ["Licence"], benefits: [], aboutCompany: "" }]));

    const summary = await run({ apply: true, extract });

    expect(summary).toMatchObject({ unmatched: 2, updated: 0 });
    expect((await Job.findById(first._id)).requirements).toEqual([]);
  });

  it("counts a post that is no longer a job post, and one with nothing to add", async () => {
    const notJob = await makeJob(await makePost({ text: `${POST_TEXT} one` }), { title: "A", createdAt: new Date("2026-01-01") });
    const nothing = await makeJob(await makePost({ text: `${POST_TEXT} two` }), { title: "B", createdAt: new Date("2026-01-02"), applyEmail: "someone@gmail.com" });
    const extract = vi.fn(async ({ text }) =>
      text.endsWith("one")
        ? { ...okExtraction([extractedJob(notJob)]), isJobPost: false }
        : okExtraction([extractedJob(nothing, { requirements: [], benefits: [] })])
    );

    const summary = await run({ apply: true, extract });

    expect(summary).toMatchObject({ notJob: 1, nothingToAdd: 1, updated: 0 });
  });

  it("skips jobs whose raw post has been purged or is too short", async () => {
    await makeJob(null, { title: "No post" });
    await makeJob(await makePost({ text: "Hiring." }), { title: "Short" });
    await makeJob({ _id: new mongoose.Types.ObjectId() }, { title: "Purged" });
    const extract = vi.fn();

    const summary = await run({ apply: true, extract });

    expect(extract).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ candidates: 3, noPost: 3, llmCalls: 0 });
  });

  describe("domain", () => {
    it("fills a missing domain and never replaces one that is set", async () => {
      const post = await makePost({ text: `${POST_TEXT} a` });
      const post2 = await makePost({ text: `${POST_TEXT} b` });
      const empty = await makeJob(post, { title: "Empty domain", createdAt: new Date("2026-01-01") });
      const set = await makeJob(post2, { title: "Set domain", domain: "chosen-by-admin.com", createdAt: new Date("2026-01-02") });
      const extract = vi.fn(async ({ text }) => okExtraction([extractedJob(text.endsWith(" a") ? empty : set)]));

      await run({ apply: true, extract });

      expect((await Job.findById(empty._id)).domain).toBe("acme.com");
      expect((await Job.findById(set._id)).domain).toBe("chosen-by-admin.com");
    });

    it("adds only the domain when the post has no sections", async () => {
      const job = await makeJob(await makePost(), { applicationLink: "https://jobs.acme.io/1" });
      const extract = fakeExtract(() => okExtraction([extractedJob(job, { requirements: [], benefits: [], aboutCompany: "" })]));

      const summary = await run({ apply: true, extract });

      expect(summary.updated).toBe(1);
      const stored = await Job.findById(job._id).lean();
      expect(stored.domain).toBe("jobs.acme.io");
      expect(stored.requirements).toEqual([]);
    });
  });

  describe("safety", () => {
    it("does not overwrite sections a person filled while the model was running", async () => {
      const post = await makePost();
      const job = await makeJob(post);
      const extract = vi.fn(async () => {
        await Job.updateOne({ _id: job._id }, { $set: { requirements: ["Typed by an admin"] } });
        return okExtraction([extractedJob(job)]);
      });

      const summary = await run({ apply: true, extract });

      expect(summary).toMatchObject({ updated: 0, changedMeanwhile: 1 });
      expect((await Job.findById(job._id)).requirements).toEqual(["Typed by an admin"]);
      expect((await Job.findById(job._id)).benefits).toEqual([]);
    });

    it("does not touch a job that was approved or rejected while the model was running", async () => {
      const job = await makeJob(await makePost());
      const extract = vi.fn(async () => {
        await Job.updateOne({ _id: job._id }, { $set: { reviewStatus: "published" } });
        return okExtraction([extractedJob(job)]);
      });

      const summary = await run({ apply: true, extract });

      expect(summary.updated).toBe(0);
      expect((await Job.findById(job._id)).requirements).toEqual([]);
    });

    it("is safe to run again: finished jobs are not selected, the rest are retried", async () => {
      const done = await makeJob(await makePost({ text: `${POST_TEXT} one` }), { title: "Done", createdAt: new Date("2026-01-01") });
      const empty = await makeJob(await makePost({ text: `${POST_TEXT} two` }), { title: "Empty", createdAt: new Date("2026-01-02") });
      const extract = vi.fn(async ({ text }) =>
        okExtraction(text.endsWith("one") ? [extractedJob(done)] : [extractedJob(empty, { requirements: [], benefits: [], aboutCompany: "" })]
        )
      );
      await Job.updateOne({ _id: empty._id }, { $set: { applyEmail: "x@gmail.com" } });

      const first = await run({ apply: true, extract });
      expect(first).toMatchObject({ candidates: 2, updated: 1, nothingToAdd: 1 });

      extract.mockClear();
      const second = await run({ apply: true, extract });

      expect(second.candidates).toBe(1);
      expect(extract).toHaveBeenCalledTimes(1);
      expect((await Job.findById(done._id)).requirements).toEqual(["Excel"]);
    });

    it("keeps the model's values inside the model's limits: invalid values are skipped, not stored", async () => {
      const job = await makeJob(await makePost());
      const extract = fakeExtract(() => okExtraction([extractedJob(job, { aboutCompany: "a".repeat(2500) })]));
      const log = silent();

      const summary = await run({ apply: true, extract, log });

      expect(summary).toMatchObject({ failed: 1, updated: 0 });
      expect((await Job.findById(job._id)).aboutCompany).toBe("");
      expect(log).toHaveBeenCalledWith(expect.stringContaining(`job ${job._id}`));
    });

    it("logs failures as one short line and leaves the job untouched", async () => {
      const job = await makeJob(await makePost());
      const secret = "fake-secret-must-not-appear-in-logs";
      const extract = vi.fn(async () => {
        const error = new Error("LLM request failed (status 500).");
        error.status = 500;
        error.request = { headers: { "x-api-key": secret } };
        error.usage = { input: 7, output: 0 };
        throw error;
      });
      const log = silent();

      const summary = await run({ apply: true, extract, log });

      expect(summary).toMatchObject({ failed: 1, updated: 0, inputTokens: 7 });
      expect(log).toHaveBeenCalledTimes(1);
      const [line] = log.mock.calls[0];
      expect(typeof line).toBe("string");
      expect(line).toBe(`backfill: job ${job._id} extraction failed: LLM request failed (status 500).`);
      expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
      expect((await Job.findById(job._id)).requirements).toEqual([]);
    });

    it("aborts after five failures in a row", async () => {
      for (let index = 0; index < 7; index += 1) {
        await makeJob(await makePost({ text: `${POST_TEXT} ${index}` }), { title: `Job ${index}`, createdAt: new Date(2026, 0, index + 1) });
      }
      const extract = vi.fn(async () => {
        throw new Error("LLM request failed.");
      });

      const summary = await run({ apply: true, extract });

      expect(extract).toHaveBeenCalledTimes(5);
      expect(summary).toMatchObject({ failed: 5, abortedByErrors: true });
    });
  });
});
