// One-time backfill of the optional job sections (aboutCompany, requirements,
// benefits) and the logo domain for pending-review Telegram jobs:
//   npm run backfill:sections                          dry run: prints counts only
//   npm run backfill:sections -- --apply --yes-db=NAME writes (NAME must be the connected database)
//   npm run backfill:sections -- --limit 50            at most 50 jobs, oldest first
//   npm run backfill:sections -- --max-calls 20        at most 20 LLM calls
//
// Re-extracts from the stored Telegram post and only $sets those fields (see
// src/services/ingestion/backfillSections.js). Uses the daily LLM counter shared
// with ingestion, but never more than 80% of the daily cap. Prints COUNTS ONLY:
// never post text, connection strings, keys or whole error objects. The
// connected database host and name are printed right after connecting.

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import mongoose from "mongoose";
import { getConfig } from "../src/services/ingestion/config.js";
import {
  applyTargetError,
  parseBackfillArgs,
  runSectionsBackfill,
} from "../src/services/ingestion/backfillSections.js";

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

let options;
try {
  options = parseBackfillArgs(process.argv.slice(2));
} catch (error) {
  fail(error.message);
}
const { apply, limit, maxCalls, yesDb } = options;

if (apply && !yesDb) {
  fail("--apply needs --yes-db=<dbname> (the name of the database you mean to write to). Nothing was written.");
}

const config = getConfig();

if (!process.env.MONGO_URI) fail("MONGO_URI is not set.");
if (apply && !config.anthropicApiKey) fail("ANTHROPIC_API_KEY is not set; --apply needs it.");

// 1 when the run crashed, was refused, or did not finish its work because of errors.
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
    const client = apply
      ? new Anthropic({ apiKey: config.anthropicApiKey, maxRetries: 1, timeout: 60_000 })
      : undefined;

    const summary = await runSectionsBackfill({ apply, limit, maxCalls, client, config });
    console.log(JSON.stringify({ db: dbName, ...summary }));
    if (summary.abortedByErrors) exitCode = 1;
  }
} catch (error) {
  exitCode = 1;
  // A driver error can quote the connection string: never print one.
  const message = String(error?.message || "unknown error").replace(/mongodb(\+srv)?:\/\/\S+/gi, "[redacted]");
  console.error(`Backfill failed: ${message.slice(0, 200)}`);
} finally {
  await mongoose.disconnect().catch(() => {});
}

process.exitCode = exitCode;
