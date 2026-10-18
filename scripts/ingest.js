// Telegram ingestion entry point, meant for a scheduler (cron / platform job):
//   npm run ingest
//
// Does nothing unless INGESTION_ENABLED=true. Prints COUNTS ONLY: never post
// text, never environment values, never whole error objects (SDK errors can
// carry request metadata).

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import mongoose from "mongoose";
import connectDB from "../src/config/db.js";
import { getConfig } from "../src/services/ingestion/config.js";
import { ingestionExitCode, runIngestion } from "../src/services/ingestion/pipeline.js";

const config = getConfig();

if (!config.enabled) {
  console.log("Ingestion disabled");
  process.exit(0);
}

if (!config.anthropicApiKey) {
  console.error("ANTHROPIC_API_KEY is not set; ingestion cannot run.");
  process.exit(1);
}

// 1 when the run crashed or did not get its work done (see ingestionExitCode),
// so the scheduler alerts. "disabled" and a normal lease_held skip exit 0.
let exitCode = 0;

try {
  await connectDB();

  const client = new Anthropic({
    apiKey: config.anthropicApiKey,
    maxRetries: 1,
    timeout: 60_000,
  });

  const summary = await runIngestion({ client, config });
  console.log(JSON.stringify(summary));
  exitCode = ingestionExitCode(summary);
} catch (error) {
  exitCode = 1;
  console.error(`Ingestion failed: ${String(error?.message || "unknown error").slice(0, 300)}`);
} finally {
  await mongoose.disconnect().catch(() => {});
}

process.exitCode = exitCode;
