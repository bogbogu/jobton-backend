// One-time: send Telegram posts that were skipped as 'No text.' (image-only
// flyers) back to "new" so the next ingestion run reads their pictures:
//   npm run requeue:images                           dry run: prints counts only
//   npm run requeue:images -- --apply --yes-db=NAME  writes (NAME must be the connected database)
//
// Needs INGESTION_IMAGES_ENABLED=true, otherwise the posts would just be
// skipped again. Only posts whose photo URLs were stored can be re-queued;
// older ones are only counted. Makes no LLM call and no network request.
// Prints COUNTS ONLY: never post text, URLs, connection strings or whole error
// objects. The connected database host and name are printed after connecting.

import "dotenv/config";
import mongoose from "mongoose";
import { applyTargetError } from "../src/services/ingestion/backfillSections.js";
import { imagesDisabledError, parseRequeueArgs, runRequeue } from "../src/services/ingestion/requeueImagePosts.js";

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

let options;
try {
  options = parseRequeueArgs(process.argv.slice(2));
} catch (error) {
  fail(error.message);
}
const { apply, yesDb } = options;

if (apply && !yesDb) {
  fail("--apply needs --yes-db=<dbname> (the name of the database you mean to write to). Nothing was written.");
}

const disabled = imagesDisabledError();
if (disabled) fail(disabled);

if (!process.env.MONGO_URI) fail("MONGO_URI is not set.");

let exitCode = 0;

try {
  await mongoose.connect(process.env.MONGO_URI);

  // Host and database name only (the driver exposes no credentials here).
  const dbName = mongoose.connection.name;
  console.error(`Connected: host=${mongoose.connection.host} db=${dbName}`);

  const refusal = applyTargetError({ apply, yesDb, dbName });
  if (refusal) {
    console.error(refusal);
    exitCode = 1;
  } else {
    const summary = await runRequeue({ apply });
    console.log(JSON.stringify({ db: dbName, ...summary }));
  }
} catch (error) {
  exitCode = 1;
  // A driver error can quote the connection string: never print one.
  const message = String(error?.message || "unknown error").replace(/mongodb(\+srv)?:\/\/\S+/gi, "[redacted]");
  console.error(`Requeue failed: ${message.slice(0, 200)}`);
} finally {
  await mongoose.disconnect().catch(() => {});
}

process.exitCode = exitCode;
