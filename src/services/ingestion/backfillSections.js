import Job from "../../models/job.model.js";
import TelegramPost from "../../models/telegramPost.model.js";
import { getLlmCallsToday, recordUsage, reserveLlmCall } from "../../models/ingestionUsage.model.js";
import { deriveCompanyDomain } from "../../utils/companyDomain.js";
import { getConfig } from "./config.js";
import { computeDedupeKey, normalizeForHash } from "./dedupe.js";
import { extractJobsFromPost } from "./extractJob.js";
import { shortError } from "./pipeline.js";

// One-time backfill for the optional sections (aboutCompany, requirements,
// benefits) of jobs that were ingested before those fields existed, plus the
// logo `domain` when a job has none.
//
// Safety rules:
//  - Only pending_review Telegram jobs whose three sections are ALL empty are
//    selected, so a job a human (or a later ingestion) already filled is never
//    touched, and a re-run only revisits jobs that are still empty. A job a
//    human has reviewed (review.reviewedBy) or restored (review.restoredAt) is
//    skipped as well.
//  - The ONLY fields written are aboutCompany, requirements, benefits and
//    (when the job has none) domain. Everything else, admin edits included, is
//    left alone; the write is conditional on the job still being pending and
//    still empty, so a concurrent edit wins.
//  - Every LLM call goes through the same atomic daily counter as the ingestion
//    pipeline, but only up to 80% of the daily cap: the last 20% stays free for
//    ingestion. The run stops cleanly when that limit (or --max-calls) is reached.
//  - Output is counts and ids only: no post text, no errors beyond a short message.

const MIN_POST_CHARS = 40;
// Share of the daily LLM cap the backfill must leave to ingestion.
const HEADROOM_SHARE = 0.2;
const MAX_CONSECUTIVE_LLM_FAILURES = 5;

const defaultLog = (message) => console.error(message);

const EMPTY_SECTIONS_FILTER = {
  aboutCompany: { $in: [null, ""] },
  // Matches a missing field, null and [] (a non-empty array has an element 0).
  "requirements.0": { $exists: false },
  "benefits.0": { $exists: false },
};

const EMPTY_DOMAIN = { $in: [null, ""] };

// A human has touched the job: someone reviewed it or a superadmin restored it.
// (`null` matches a missing field.)
const UNTOUCHED_BY_HUMANS_FILTER = {
  "review.reviewedBy": null,
  "review.restoredAt": null,
};

export const backfillCandidateFilter = () => ({
  "source.kind": "telegram",
  reviewStatus: "pending_review",
  ...EMPTY_SECTIONS_FILTER,
  ...UNTOUCHED_BY_HUMANS_FILTER,
});

// How many LLM calls the backfill may make in total today: the daily cap minus
// the share kept for ingestion. reserveLlmCall(this) refuses once today's counter
// reaches it, so at least HEADROOM_SHARE of the cap is always left.
export const backfillCallCeiling = (dailyCap) =>
  Number.isFinite(dailyCap) && dailyCap > 0 ? Math.floor(dailyCap * (1 - HEADROOM_SHARE)) : 0;

// ---- command line ------------------------------------------------------------------------------
// Returns { apply, limit, maxCalls, yesDb } or throws an Error with a short message.
export function parseBackfillArgs(args = []) {
  const options = { apply: false, limit: undefined, maxCalls: undefined, yesDb: undefined };

  const positiveInt = (name, raw) => {
    if (!/^\d+$/.test(String(raw ?? ""))) throw new Error(`${name} needs a positive whole number.`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} needs a positive whole number.`);
    return value;
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const [flag, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];

    if (flag === "--apply" && inline === undefined) {
      options.apply = true;
    } else if (flag === "--limit") {
      options.limit = positiveInt("--limit", inline ?? args[++index]);
    } else if (flag === "--max-calls") {
      options.maxCalls = positiveInt("--max-calls", inline ?? args[++index]);
    } else if (flag === "--yes-db" && inline !== undefined) {
      if (!inline) throw new Error("--yes-db needs a database name: --yes-db=<dbname>.");
      options.yesDb = inline;
    } else {
      throw new Error("Usage: backfill-sections.js [--apply --yes-db=<dbname>] [--limit N] [--max-calls N]");
    }
  }

  return options;
}

// --apply writes to whatever database MONGO_URI points at, so it must be told
// the database name it is expected to hit. Returns an error message, or null
// when it is fine to continue. Dry runs need no confirmation.
export function applyTargetError({ apply, yesDb, dbName }) {
  if (!apply) return null;
  if (!yesDb) {
    return `--apply needs --yes-db=<dbname>; the connected database is "${dbName}". Nothing was written.`;
  }
  if (yesDb !== dbName) {
    return `--yes-db does not match the connected database "${dbName}". Nothing was written.`;
  }
  return null;
}

// Which of the freshly extracted jobs is this stored job? The dedupeKey (set at
// creation from the same fields) is the exact answer; the title is the fallback
// for jobs the extractor now words slightly differently; a post that produced
// exactly one job and still produces exactly one is matched by position. Null
// when it is not clear, so the sections of the wrong vacancy are never attached.
export function matchExtractedJob(job, extractedJobs, { storedJobsForPost = 0 } = {}) {
  if (job.dedupeKey) {
    const exact = extractedJobs.find((candidate) => computeDedupeKey(candidate) === job.dedupeKey);
    if (exact) return exact;
  }

  const title = normalizeForHash(job.title);
  if (title) {
    const sameTitle = extractedJobs.filter((candidate) => normalizeForHash(candidate.title) === title);
    if (sameTitle.length === 1) return sameTitle[0];
  }

  if (extractedJobs.length === 1 && storedJobsForPost === 1) return extractedJobs[0];
  return null;
}

// The $set for one job, or null when there is nothing to add.
export function buildSectionsUpdate(job, extracted) {
  const set = {};

  if (extracted?.aboutCompany) set.aboutCompany = extracted.aboutCompany;
  if (extracted?.requirements?.length) set.requirements = extracted.requirements;
  if (extracted?.benefits?.length) set.benefits = extracted.benefits;

  if (!job.domain) {
    const domain = deriveCompanyDomain({
      applicationLink: job.applicationLink,
      applyEmail: job.applyEmail,
      company: job.company,
    });
    if (domain) set.domain = domain;
  }

  return Object.keys(set).length > 0 ? set : null;
}

const emptySummary = (apply) => ({
  dryRun: !apply,
  candidates: 0,
  noPost: 0,
  withPost: 0,
  llmCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  notJob: 0,
  unmatched: 0,
  nothingToAdd: 0,
  updated: 0,
  changedMeanwhile: 0,
  failed: 0,
  stoppedByCap: false,
  stoppedByMaxCalls: false,
  abortedByErrors: false,
});

//   apply   false (default): only count, never call the LLM and never write
//   limit   process at most this many candidate jobs (oldest first)
//   maxCalls make at most this many LLM calls in this run
//   client  Anthropic client (anything with messages.parse); required for apply
//   extract injectable for tests, defaults to the real extractor
export async function runSectionsBackfill({
  apply = false,
  limit,
  maxCalls,
  client,
  config = getConfig(),
  extract = extractJobsFromPost,
  log = defaultLog,
} = {}) {
  const summary = emptySummary(apply);
  let consecutiveFailures = 0;
  let lastPost = null; // { id, jobs } so several jobs from one post cost one call

  const usedToday = await getLlmCallsToday();
  const ceiling = backfillCallCeiling(config.dailyLlmCap);
  summary.llmCallsLeftToday = Math.max(0, config.dailyLlmCap - usedToday);
  // What this backfill may still spend; the rest of the cap is kept for ingestion.
  summary.llmCallsAvailableToBackfill = Math.max(0, ceiling - usedToday);

  let query = Job.find(backfillCandidateFilter()).sort({ createdAt: 1, _id: 1 });
  if (Number.isInteger(limit) && limit > 0) query = query.limit(limit);

  for await (const job of query.cursor()) {
    summary.candidates += 1;

    try {
      const postId = job.extraction?.post;
      const post = postId ? await TelegramPost.findById(postId, { text: 1, links: 1 }).lean() : null;
      const text = (post?.text || "").trim();

      // The raw post is purged after its retention period; without it there is
      // nothing to extract from.
      if (!post || text.length < MIN_POST_CHARS) {
        summary.noPost += 1;
        continue;
      }

      summary.withPost += 1;
      if (!apply) continue;

      const key = String(post._id);
      let extractedJobs;

      if (lastPost?.id === key) {
        extractedJobs = lastPost.jobs;
      } else {
        if (Number.isInteger(maxCalls) && maxCalls > 0 && summary.llmCalls >= maxCalls) {
          summary.stoppedByMaxCalls = true;
          break;
        }
        if (!(await reserveLlmCall(ceiling))) {
          summary.stoppedByCap = true;
          break;
        }
        summary.llmCalls += 1;

        let extraction;
        try {
          extraction = await extract({
            text,
            links: post.links,
            client,
            model: config.model,
            maxTokens: config.llmMaxTokens,
          });
        } catch (error) {
          const usage = error?.usage;
          if (usage) {
            summary.inputTokens += usage.input;
            summary.outputTokens += usage.output;
            await recordUsage(usage);
          }
          summary.failed += 1;
          log(`backfill: job ${job._id} extraction failed: ${shortError(error)}`);

          consecutiveFailures += 1;
          if (consecutiveFailures >= MAX_CONSECUTIVE_LLM_FAILURES) {
            summary.abortedByErrors = true;
            break;
          }
          continue;
        }

        consecutiveFailures = 0;
        summary.inputTokens += extraction.usage.input;
        summary.outputTokens += extraction.usage.output;
        await recordUsage(extraction.usage);

        extractedJobs = extraction.isJobPost ? extraction.jobs : [];
        lastPost = { id: key, jobs: extractedJobs };
      }

      if (extractedJobs.length === 0) {
        summary.notJob += 1;
        continue;
      }

      const storedJobsForPost = await Job.countDocuments({ "extraction.post": post._id });
      const extracted = matchExtractedJob(job, extractedJobs, { storedJobsForPost });
      if (!extracted) {
        summary.unmatched += 1;
        continue;
      }

      const set = buildSectionsUpdate(job, extracted);
      if (!set) {
        summary.nothingToAdd += 1;
        continue;
      }

      // Same rules as every other write path (limits, plain text, domain format).
      try {
        await new Job(set).validate(Object.keys(set));
      } catch (error) {
        if (error?.name !== "ValidationError") throw error;
        summary.failed += 1;
        log(`backfill: job ${job._id} skipped, values failed validation`);
        continue;
      }

      const result = await Job.updateOne(
        {
          _id: job._id,
          reviewStatus: "pending_review",
          ...EMPTY_SECTIONS_FILTER,
          ...UNTOUCHED_BY_HUMANS_FILTER,
          ...(set.domain ? { domain: EMPTY_DOMAIN } : {}),
        },
        { $set: set }
      );

      if (result.modifiedCount > 0) summary.updated += 1;
      else summary.changedMeanwhile += 1;
    } catch (error) {
      summary.failed += 1;
      log(`backfill: job ${job._id} failed: ${shortError(error)}`);
    }
  }

  return summary;
}
