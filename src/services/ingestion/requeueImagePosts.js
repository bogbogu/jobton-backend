import TelegramPost from "../../models/telegramPost.model.js";
import { filterAllowedImageUrls } from "../../utils/telegramImageUrl.js";

// One-time helper for posts that were skipped as 'No text.' before images were
// read. A post can only be read again if its photo URLs were stored (posts
// stored before that feature have none; they are only counted).
//
// Safety rules:
//  - Only status "skipped" + error "No text." + hasImage posts are touched.
//  - Only posts that still have at least one allow-listed image URL are reset.
//  - The write is conditional on the post still being in that state, and sets
//    only status/attempts (and unsets error): the next ingestion run picks the
//    posts up like any new post, under the usual daily LLM cap.
//  - A post whose image turns out to hold no text is skipped again with a
//    DIFFERENT error ('No readable text in image.'), so running this twice does
//    not queue it twice.

export const REQUEUE_ERROR = "No text.";
const BATCH = 200;

// Returns { apply, yesDb } or throws an Error with a short message.
export function parseRequeueArgs(args = []) {
  const options = { apply: false, yesDb: undefined };

  for (const arg of args) {
    if (arg === "--apply") options.apply = true;
    else if (arg.startsWith("--yes-db=")) options.yesDb = arg.slice("--yes-db=".length);
    else throw new Error(`Unknown argument: ${String(arg).slice(0, 40)}`);
  }

  return options;
}

// The images feature must be on: requeued posts would otherwise be skipped as
// 'No text.' again on the next run.
export const imagesDisabledError = (env = process.env) =>
  env.INGESTION_IMAGES_ENABLED === "true"
    ? null
    : "INGESTION_IMAGES_ENABLED is not 'true'; re-queued posts would be skipped again. Nothing was changed.";

const skippedImagePostFilter = () => ({
  hasImage: true,
  status: "skipped",
  error: REQUEUE_ERROR,
});

// Counts only; never post text. `requeueable` are the post ids that can be reset.
export async function selectRequeueCandidates() {
  const base = skippedImagePostFilter();

  // Older posts, stored before photo URLs were kept: nothing to read from.
  const withoutUrls = await TelegramPost.countDocuments({ ...base, "imageUrls.0": { $exists: false } });

  const requeueable = [];
  const cursor = TelegramPost.find({ ...base, "imageUrls.0": { $exists: true } }, { imageUrls: 1 })
    .sort({ _id: 1 })
    .lean()
    .cursor();
  for await (const post of cursor) {
    // The schema only stores allow-listed URLs; checked again before anything is reset.
    if (filterAllowedImageUrls(post.imageUrls).length > 0) requeueable.push(post._id);
  }

  return { requeueable, withoutUrls };
}

export async function runRequeue({ apply = false } = {}) {
  const { requeueable, withoutUrls } = await selectRequeueCandidates();
  let requeued = 0;

  if (apply) {
    for (let index = 0; index < requeueable.length; index += BATCH) {
      const ids = requeueable.slice(index, index + BATCH);
      const result = await TelegramPost.updateMany(
        { _id: { $in: ids }, ...skippedImagePostFilter() },
        { $set: { status: "new", attempts: 0 }, $unset: { error: "" } }
      );
      requeued += result.modifiedCount || 0;
    }
  }

  return {
    mode: apply ? "apply" : "dry-run",
    candidates: requeueable.length,
    withoutStoredUrls: withoutUrls,
    requeued,
  };
}
