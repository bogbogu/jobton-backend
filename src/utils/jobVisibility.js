// Single source of truth for "which jobs may the public see".
//
// Allow-list, not deny-list: a job is public only if its reviewStatus is
// "published". Legacy jobs created before the review workflow have NO
// reviewStatus field; `$in: [..., null]` matches a missing field in MongoDB,
// so they stay public without a data migration. Any new state added later
// (e.g. "needs_changes") is hidden by default.
//
// EVERY query that returns jobs to a non-admin must include this filter:
// list, detail, categories, saved jobs, company pages, loadJob.

export const REVIEW_STATUSES = ["pending_review", "published", "rejected"];

// A FRESH object on every call: Mongoose and callers add keys to / cast
// filters in place, so a shared object would leak state between queries.
export const publicJobFilter = () => ({
  reviewStatus: { $in: ["published", null] },
});

// For an already-loaded document (mongoose doc or plain object).
export const isPublishedJob = (job) =>
  !job?.reviewStatus || job.reviewStatus === "published";
