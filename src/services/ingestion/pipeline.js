import Job from "../../models/job.model.js";
import TelegramChannel from "../../models/telegramChannel.model.js";
import TelegramPost from "../../models/telegramPost.model.js";
import IngestionLock, { acquireLease, releaseLease, renewLease } from "../../models/ingestionLock.model.js";
import IngestionUsage, {
  getLlmCallsToday,
  recordUsage,
  reserveLlmCall,
} from "../../models/ingestionUsage.model.js";
import { cleanText, classifyLink } from "../../utils/validators.utils.js";
import { deriveCompanyDomain } from "../../utils/companyDomain.js";
import { getConfig } from "./config.js";
import { computeDedupeKey, hashPostText } from "./dedupe.js";
import { extractJobsFromPost } from "./extractJob.js";
import { computeRedFlags } from "./redFlags.js";
import { fetchChannelPage } from "./telegramFetch.js";
import { parseChannelHtml } from "./telegramParse.js";

const LEASE_NAME = "telegram-ingestion";
const LEASE_TTL_MS = 30 * 60 * 1000;
// Renew the lease at least this often (in posts) while working through them.
const RENEW_EVERY_POSTS = 10;
const MIN_POST_CHARS = 40;
const MAX_CONSECUTIVE_CHANNEL_FAILURES = 10;
// A run that keeps failing at the LLM (bad key, outage) must not burn the
// whole daily budget on doomed calls.
const MAX_CONSECUTIVE_LLM_FAILURES = 5;
// A post that keeps failing transiently (e.g. a payload that always makes the
// API answer 5xx) is tried this many times in total, then marked "failed" so
// it cannot burn budget on every run forever.
const MAX_TRANSIENT_ATTEMPTS = 5;
const DUPLICATE_KEY = 11000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const defaultLog = (message) => console.error(message);

// Only ever a short plain string: never an error object, request or response.
export const shortError = (error, max = 200) => {
  const message = typeof error === "string" ? error : error?.message;
  const text = cleanText(String(message || "Unknown error")).replace(/\s+/g, " ").trim();
  return (text || "Unknown error").slice(0, max);
};

// Transient = worth retrying on a later run: no status at all (timeout,
// network error), 429 and 5xx. extractJob.js wraps API errors as
// "LLM request failed (status N)." / "LLM request failed." and keeps no other
// field, so the status is read from `error.status` when present and parsed
// from the message otherwise. Refusals, unparsable output and other 4xx are
// permanent.
export function isTransientLlmError(error) {
  const message = typeof error?.message === "string" ? error.message : "";
  let status = Number.isInteger(error?.status) ? error.status : undefined;

  if (status === undefined) {
    if (!/^LLM request failed/.test(message)) return false;
    const match = /status (\d{3})/.exec(message);
    status = match ? Number(match[1]) : undefined;
  }

  if (status === undefined) return true;
  return status === 429 || status >= 500;
}

// Exit code for the scheduler: non-zero when the run did not get its work done
// (aborted on repeated LLM failures, lost its lease, or every channel it tried
// failed to poll). A normal "lease_held" skip is not an error.
export function ingestionExitCode(summary) {
  if (!summary || summary.skipped) return 0;
  if (summary.abortedByErrors || summary.leaseLost) return 1;
  if (summary.channelsAttempted > 0 && summary.channelsFailed >= summary.channelsAttempted) return 1;
  return 0;
}

const emptySummary = () => ({
  channels: 0,
  channelsAttempted: 0,
  channelsFailed: 0,
  gapSkipped: 0,
  fetched: 0,
  stored: 0,
  duplicates: 0,
  skipped: 0,
  notJob: 0,
  extracted: 0,
  jobsCreated: 0,
  failed: 0,
  transientFailures: 0,
  llmCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  stoppedByCap: false,
  abortedByErrors: false,
  leaseLost: false,
});

// Unique indexes are what make locking, the daily cap and post/job
// de-duplication safe, so make sure they exist before relying on them
// (autoIndex builds them in the background right after connecting).
async function ensureIndexes(log) {
  await Promise.all([
    // If the unique dedupeKey index cannot be built (pre-existing duplicate
    // keys) fall back to the lookup-only check instead of blocking all
    // ingestion, but say so.
    Job.init().catch((error) => {
      log(`ingestion: could not ensure job indexes: ${shortError(error)}`);
    }),
    IngestionLock.init(),
    IngestionUsage.init(),
    TelegramPost.init(),
    TelegramChannel.init(),
  ]);
}

// Extends our lease. Returns false (and flags the run) when it is no longer
// ours, in which case the caller must stop cleanly: another run may already be
// working. A failed renewal call is treated the same way, to be safe.
async function keepLease(ctx) {
  const { state, summary, log } = ctx;
  if (state.leaseLost) return false;

  let renewed = false;
  try {
    renewed = await renewLease(LEASE_NAME, ctx.owner, LEASE_TTL_MS);
  } catch (error) {
    log(`ingestion: could not renew lease: ${shortError(error)}`);
  }

  if (!renewed) {
    state.leaseLost = true;
    summary.leaseLost = true;
    log("ingestion: lease lost, stopping the run");
  }
  return renewed;
}

const isDuplicateKeyError = (error) => error?.code === DUPLICATE_KEY || error?.cause?.code === DUPLICATE_KEY;

// ---- phase 1: fetch & store -----------------------------------------------------------------
async function pollChannel(channel, ctx) {
  const { config, fetchImpl, sleep, summary, state, log } = ctx;
  const baseline = channel.lastMessageId || 0;
  let highestSeen = baseline;
  let beforeId;
  let reachedBaseline = false;

  for (let page = 0; page < config.maxPagesPerChannel; page += 1) {
    if (state.requests > 0 && config.fetchDelayMs > 0) await sleep(config.fetchDelayMs);
    state.requests += 1;

    const html = await fetchChannelPage(channel.username, {
      beforeId,
      fetchImpl,
      timeoutMs: config.requestTimeoutMs,
      maxBytes: config.maxResponseBytes,
    });

    const posts = parseChannelHtml(html, channel.username);
    if (posts.length === 0) {
      reachedBaseline = true; // nothing older to fetch
      break;
    }

    summary.fetched += posts.length;
    const ids = posts.map((post) => post.messageId);
    const oldest = Math.min(...ids);
    highestSeen = Math.max(highestSeen, ...ids);

    // Posts at or below the stored high-water mark were already seen on an
    // earlier run (and may have been expired by the retention TTL); skip them.
    summary.stored += await storeNewPosts(
      channel.username,
      posts.filter((post) => post.messageId > baseline),
      config
    );

    beforeId = oldest;
    if (oldest <= baseline || oldest <= 1) {
      reachedBaseline = true;
      break;
    }
  }

  // The page cap ended the run before reaching the old high-water mark: the
  // messages between the two are never fetched (the mark moves up to the
  // newest id). Say so instead of losing them silently.
  if (!reachedBaseline && baseline > 0 && beforeId > baseline + 1) {
    summary.gapSkipped += 1;
    log(
      `ingestion: channel ${channel.username} page limit reached; messages ${baseline + 1}-${beforeId - 1} were skipped`
    );
  }

  return highestSeen;
}

// Inserts posts not stored yet. ONLY duplicate-key errors (a concurrent writer
// stored the same post) are tolerated; anything else is rethrown so the caller
// does not advance the channel's high-water mark past posts that were not stored.
async function storeNewPosts(channel, posts, config) {
  if (posts.length === 0) return 0;

  const existing = await TelegramPost.find(
    { channel, messageId: { $in: posts.map((post) => post.messageId) } },
    { messageId: 1 }
  ).lean();
  const known = new Set(existing.map((doc) => doc.messageId));

  const docs = posts
    .filter((post) => !known.has(post.messageId))
    .map((post) => ({
      channel,
      messageId: post.messageId,
      postedAt: post.postedAt,
      text: post.text.slice(0, config.maxPostTextChars),
      hasImage: post.hasImage,
      links: post.links,
      contentHash: post.text ? hashPostText(post.text) : undefined,
      status: "new",
      fetchedAt: new Date(),
    }));

  if (docs.length === 0) return 0;

  try {
    const inserted = await TelegramPost.insertMany(docs, { ordered: false });
    return inserted.length;
  } catch (error) {
    const writeErrors = Array.isArray(error?.writeErrors) ? error.writeErrors : [];

    if (writeErrors.length > 0) {
      const onlyDuplicates = writeErrors.every((entry) => (entry?.code ?? entry?.err?.code) === DUPLICATE_KEY);
      if (!onlyDuplicates) throw error;
      return Math.max(0, docs.length - writeErrors.length);
    }

    // No per-document detail: a bare duplicate-key error stored nothing we can count.
    if (error?.code === DUPLICATE_KEY) return 0;
    throw error;
  }
}

async function pollChannels(channels, ctx) {
  const { log, summary } = ctx;

  for (const channel of channels) {
    if (!(await keepLease(ctx))) return;
    summary.channelsAttempted += 1;

    try {
      const highestSeen = await pollChannel(channel, ctx);
      await TelegramChannel.updateOne(
        { _id: channel._id },
        {
          $set: {
            lastPolledAt: new Date(),
            lastMessageId: Math.max(channel.lastMessageId || 0, highestSeen),
            consecutiveFailures: 0,
          },
          $unset: { lastError: "" },
        }
      );
    } catch (error) {
      summary.channelsFailed += 1;
      const failures = (channel.consecutiveFailures || 0) + 1;
      const message = shortError(error, 280);
      log(`ingestion: channel ${channel.username} poll failed: ${message}`);
      // lastMessageId is deliberately not touched here: posts that could not
      // be stored must be fetched again next run.
      await TelegramChannel.updateOne(
        { _id: channel._id },
        {
          $set: {
            lastPolledAt: new Date(),
            consecutiveFailures: failures,
            lastError: message,
            ...(failures >= MAX_CONSECUTIVE_CHANNEL_FAILURES ? { active: false } : {}),
          },
        }
      );
    }
  }
}

// ---- phase 2: extract & create jobs -----------------------------------------------------------
const hasValue = (value) => value !== undefined && value !== null && value !== "";

function missingFields(job) {
  const missing = [];
  if (!job.company) missing.push("company");
  if (!job.location) missing.push("location");
  if (!hasValue(job.salaryMin)) missing.push("salaryMin");
  if (!job.category) missing.push("category");
  if (!job.employmentType) missing.push("employmentType");
  if (!job.applicationLink && !job.applyEmail && !job.applyPhone) missing.push("howToApply");
  return missing;
}

// E11000 raised by the partial unique index on Job.dedupeKey.
const isDedupeKeyConflict = (error) =>
  isDuplicateKeyError(error) &&
  (error.keyPattern?.dedupeKey !== undefined || /dedupeKey/.test(String(error.message)));

// Creates the pending-review Job for one sanitized extraction. The pipeline
// never sets badges (`status`), `postedBy` or any reviewStatus other than
// "pending_review": publishing is a human decision.
//
// Returns { job } or { duplicateOf } (id of the job that already has this
// dedupeKey; may be undefined if it vanished meanwhile).
async function createPendingJob({ extracted, post, extraction, config }) {
  const dedupeKey = computeDedupeKey(extracted);

  // Cheap check first: no red-flag / link work for something we already have.
  // Rejected jobs keep their dedupeKey on purpose, so the same spam is not
  // queued for review again.
  const existing = await Job.findOne({ dedupeKey }, { _id: 1 }).lean();
  if (existing) return { duplicateOf: existing._id };

  const linkClass = classifyLink(extracted.applicationLink, extracted.company);
  const redFlags = computeRedFlags({ job: extracted, text: post.text, linkClass });
  const missing = missingFields(extracted);
  const hasSalary = hasValue(extracted.salaryMin);
  const domain = deriveCompanyDomain({
    applicationLink: extracted.applicationLink,
    applyEmail: extracted.applyEmail,
    company: extracted.company,
  });

  try {
    const job = await Job.create({
      title: extracted.title,
      company: extracted.company,
      location: extracted.location,
      employmentType: extracted.employmentType,
      workArrangement: extracted.workArrangement,
      salaryMin: extracted.salaryMin,
      salaryMax: hasSalary ? extracted.salaryMax ?? null : null,
      ...(hasSalary ? { salaryCurrency: extracted.salaryCurrency } : {}),
      salaryPeriod: hasSalary ? extracted.salaryPeriod ?? null : null,
      category: extracted.category,
      skills: extracted.skills,
      experience: extracted.experience,
      qualification: extracted.qualification,
      description: extracted.description,
      responsibilities: extracted.responsibilities,
      aboutCompany: extracted.aboutCompany,
      requirements: extracted.requirements,
      benefits: extracted.benefits,
      // The extractor never returns a domain: it comes from how to apply, for the logo.
      ...(domain ? { domain } : {}),
      applicationLink: extracted.applicationLink,
      applyEmail: extracted.applyEmail,
      applyPhone: extracted.applyPhone,
      reviewStatus: "pending_review",
      source: {
        kind: "telegram",
        channel: post.channel,
        messageId: post.messageId,
        url: `https://t.me/${post.channel}/${post.messageId}`,
        postedAt: post.postedAt || undefined,
      },
      extraction: {
        model: config.model,
        corrections: extracted.corrections,
        modelNotes: extraction.modelNotes,
        redFlags,
        linkClass,
        missing,
        droppedFields: extracted.droppedFields,
        post: post._id,
      },
      dedupeKey,
    });

    return { job };
  } catch (error) {
    // Lost a race: another writer created a job with this key between our
    // lookup and the insert. The unique index guarantees exactly one wins.
    if (!isDedupeKeyConflict(error)) throw error;
    const winner = await Job.findOne({ dedupeKey }, { _id: 1 }).lean();
    return { duplicateOf: winner?._id };
  }
}

const finishPost = (post, fields) =>
  TelegramPost.updateOne(
    { _id: post._id },
    { $set: fields, ...(fields.error === undefined ? { $unset: { error: "" } } : {}) }
  );

// Returns "continue" | "stop".
async function processPost(post, ctx) {
  const { config, client, summary, state, log } = ctx;
  const text = (post.text || "").trim();

  if (text.length < MIN_POST_CHARS) {
    await finishPost(post, { status: "skipped", error: text ? "Text too short." : "No text." });
    summary.skipped += 1;
    return "continue";
  }

  // The same text already handled (repost, cross-channel copy): no LLM call.
  if (post.contentHash) {
    const original = await TelegramPost.findOne(
      {
        _id: { $ne: post._id },
        contentHash: post.contentHash,
        status: { $in: ["extracted", "not_job", "duplicate"] },
      },
      { job: 1 }
    ).lean();
    if (original) {
      await finishPost(post, { status: "duplicate", ...(original.job ? { job: original.job } : {}) });
      summary.duplicates += 1;
      return "continue";
    }
  }

  if (!(await reserveLlmCall(config.dailyLlmCap))) {
    summary.stoppedByCap = true;
    return "stop";
  }
  summary.llmCalls += 1;

  let extraction;
  try {
    extraction = await extractJobsFromPost({
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
    const message = shortError(error);
    const attempts = (post.attempts || 0) + 1;

    if (isTransientLlmError(error) && attempts < MAX_TRANSIENT_ATTEMPTS) {
      // Outage / rate limit / timeout: the post is fine, so leave it "new" for
      // the next run (the message is kept for visibility only).
      log(`ingestion: post ${post.channel}/${post.messageId} extraction failed (will retry): ${message}`);
      await TelegramPost.updateOne({ _id: post._id }, { $set: { error: message }, $inc: { attempts: 1 } });
      summary.transientFailures += 1;
    } else {
      log(`ingestion: post ${post.channel}/${post.messageId} extraction failed: ${message}`);
      await finishPost(post, { status: "failed", error: message });
      summary.failed += 1;
    }

    // Both kinds count towards aborting a run that is clearly not working.
    state.consecutiveLlmFailures += 1;
    if (state.consecutiveLlmFailures >= MAX_CONSECUTIVE_LLM_FAILURES) {
      summary.abortedByErrors = true;
      return "stop";
    }
    return "continue";
  }

  state.consecutiveLlmFailures = 0;
  summary.inputTokens += extraction.usage.input;
  summary.outputTokens += extraction.usage.output;
  await recordUsage(extraction.usage);

  if (!extraction.isJobPost || extraction.jobs.length === 0) {
    await finishPost(post, { status: "not_job" });
    summary.notJob += 1;
    return "continue";
  }

  const created = [];
  let duplicateOf;
  try {
    for (const extracted of extraction.jobs) {
      const result = await createPendingJob({ extracted, post, extraction, config });
      if (result.job) created.push(result.job);
      else duplicateOf ??= result.duplicateOf;
    }
  } catch (error) {
    const message = shortError(error);
    log(`ingestion: post ${post.channel}/${post.messageId} job creation failed: ${message}`);
    if (created.length === 0) {
      await finishPost(post, { status: "failed", error: message });
      summary.failed += 1;
      return "continue";
    }
  }

  if (created.length > 0) {
    await finishPost(post, { status: "extracted", job: created[0]._id });
    summary.extracted += 1;
    summary.jobsCreated += created.length;
    state.pendingCreated += created.length;
  } else {
    await finishPost(post, { status: "duplicate", ...(duplicateOf ? { job: duplicateOf } : {}) });
    summary.duplicates += 1;
  }
  return "continue";
}

// Works through one channel's "new" posts, oldest first, using at most `quota`
// LLM calls. Returns "done" | "cut" (quota hit with posts left) | "stop".
async function processChannel(channel, quota, ctx) {
  const { config, summary, state } = ctx;

  const pending = await Job.countDocuments({
    "source.channel": channel.username,
    reviewStatus: "pending_review",
  });
  state.pendingCreated = 0;

  // Review backlog full: leave this channel's posts as "new" until a human catches up.
  if (pending >= config.maxPendingPerChannel) return "done";

  const posts = await TelegramPost.find({ channel: channel.username, status: "new" })
    .sort({ messageId: 1 })
    .limit(config.maxPostsPerChannelRun)
    .lean();

  const callsAtStart = summary.llmCalls;

  for (const post of posts) {
    if (pending + state.pendingCreated >= config.maxPendingPerChannel) break;
    if (summary.llmCalls - callsAtStart >= quota) return "cut";

    // Long runs (many slow LLM calls) must not outlive the lease.
    state.postsSinceRenew += 1;
    if (state.postsSinceRenew >= RENEW_EVERY_POSTS) {
      state.postsSinceRenew = 0;
      if (!(await keepLease(ctx))) return "stop";
    }

    if ((await processPost(post, ctx)) === "stop") return "stop";
  }
  return "done";
}

// Fairness: one busy channel must not eat the whole daily LLM budget and leave
// the others starving every day. Each channel gets an equal share of what is
// left of today's cap, recomputed per channel: quota = ceil(remaining cap /
// channels still to process). Whatever an earlier channel does not use rolls
// over to the later ones, and a channel cut short simply continues next run
// (its posts stay "new", oldest first).
async function processChannels(channels, ctx) {
  const { config, summary } = ctx;

  const usedAtStart = await getLlmCallsToday();
  const callsAtStart = summary.llmCalls;
  const remainingCap = () => config.dailyLlmCap - usedAtStart - (summary.llmCalls - callsAtStart);
  let cutShort = false;

  for (let index = 0; index < channels.length; index += 1) {
    const channel = channels[index];
    if (!(await keepLease(ctx))) return;

    // A channel auto-deactivated while polling must not be processed this run.
    const fresh = await TelegramChannel.findById(channel._id, { active: 1 }).lean();
    if (!fresh?.active) continue;

    const share = Math.ceil(remainingCap() / (channels.length - index));
    // At least 1 so an exhausted cap is detected (and reported) by reserveLlmCall.
    const quota = Number.isFinite(share) ? Math.max(1, share) : 1;

    const outcome = await processChannel(channel, quota, ctx);
    if (outcome === "stop") return;
    if (outcome === "cut") cutShort = true;
  }

  if (cutShort && remainingCap() <= 0) summary.stoppedByCap = true;
}

// ---- entry point -------------------------------------------------------------------------------
// One ingestion run. Everything external is injectable so tests never touch
// the network or the real Anthropic API.
//   fetchImpl  fetch-compatible function used for t.me pages
//   client     Anthropic client (anything with messages.parse)
//   config     defaults to getConfig()
//   sleep      (ms) => Promise, used for the delay between page requests
export async function runIngestion({
  fetchImpl = globalThis.fetch,
  client,
  config = getConfig(),
  sleep = defaultSleep,
  log = defaultLog,
} = {}) {
  const summary = emptySummary();

  await ensureIndexes(log);

  const owner = await acquireLease(LEASE_NAME, LEASE_TTL_MS);
  if (!owner) {
    return { skipped: "lease_held" };
  }

  try {
    const channels = await TelegramChannel.find({ active: true }).sort({ lastPolledAt: 1, _id: 1 });
    summary.channels = channels.length;

    const ctx = {
      config,
      fetchImpl,
      client,
      sleep,
      log,
      summary,
      owner,
      state: {
        requests: 0,
        consecutiveLlmFailures: 0,
        pendingCreated: 0,
        postsSinceRenew: 0,
        leaseLost: false,
      },
    };

    await pollChannels(channels, ctx);
    if (!ctx.state.leaseLost) await processChannels(channels, ctx);

    return summary;
  } finally {
    // Only releases if the lease is still ours.
    await releaseLease(LEASE_NAME, owner).catch((error) => {
      log(`ingestion: could not release lease: ${shortError(error)}`);
    });
  }
}
