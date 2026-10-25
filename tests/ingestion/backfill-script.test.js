import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Job from "../../src/models/job.model.js";
import IngestionUsage from "../../src/models/ingestionUsage.model.js";

// Runs the real scripts/backfill-sections.js as a child process against the
// in-memory MongoDB. No LLM call can happen: the only job has no stored post.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DB_NAME = "backfill_script_db";

let mongoServer;
let uri;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  uri = mongoServer.getUri(DB_NAME);
  await mongoose.connect(uri);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await Promise.all([Job.deleteMany({}), IngestionUsage.deleteMany({})]);
  await Job.create({
    title: "Accountant",
    description: "An accountant role.",
    company: "Acme",
    location: "Lagos",
    applyEmail: "hr@acme.com",
    reviewStatus: "pending_review",
    source: { kind: "telegram", channel: "tohire_ng", messageId: 1 },
  });
});

const runScript = (args, env = {}) =>
  spawnSync(process.execPath, ["scripts/backfill-sections.js", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 60000,
    env: {
      ...process.env,
      MONGO_URI: uri,
      ANTHROPIC_API_KEY: "placeholder-not-a-real-key",
      INGESTION_DAILY_LLM_CAP: "10",
      ...env,
    },
  });

const summaryOf = (result) => JSON.parse(result.stdout.trim().split("\n").pop());

describe("scripts/backfill-sections.js", () => {
  it("dry run: prints the host and database right after connecting, and the db in the summary", async () => {
    const result = runScript([]);

    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/Connected: host=\S+ db=backfill_script_db/);
    const summary = summaryOf(result);
    expect(summary).toMatchObject({ db: DB_NAME, dryRun: true, candidates: 1, noPost: 1, llmCalls: 0 });
    // Never a connection string or credentials.
    expect(result.stdout + result.stderr).not.toMatch(/mongodb(\+srv)?:\/\//i);
    expect(result.stdout + result.stderr).not.toContain("placeholder-not-a-real-key");
  });

  it("--apply without --yes-db exits non-zero and writes nothing", async () => {
    const result = runScript(["--apply"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--yes-db=<dbname>/);
    expect(result.stdout).toBe("");
    expect(await IngestionUsage.countDocuments()).toBe(0);
  });

  it("--apply with the wrong database name exits non-zero after showing where it connected, and writes nothing", async () => {
    const result = runScript(["--apply", "--yes-db=some_other_db"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/db=backfill_script_db/);
    expect(result.stderr).toMatch(/does not match the connected database "backfill_script_db"/);
    expect(result.stdout).toBe("");
    expect(await IngestionUsage.countDocuments()).toBe(0);
    expect((await Job.findOne({})).domain).toBe("");
  });

  it("--apply with the matching database name runs and reports the db", async () => {
    const result = runScript(["--apply", `--yes-db=${DB_NAME}`, "--max-calls", "3"]);

    expect(result.status).toBe(0);
    expect(summaryOf(result)).toMatchObject({ db: DB_NAME, dryRun: false, candidates: 1, noPost: 1, llmCalls: 0 });
  });

  it("rejects bad flags before connecting", async () => {
    for (const args of [["--bogus"], ["--limit", "0"], ["--max-calls", "x"], ["--yes-db"]]) {
      const result = runScript(args);
      expect(result.status, args.join(" ")).toBe(1);
      expect(result.stderr).not.toMatch(/Connected:/);
    }
  });

  it("fails without printing the connection string when the database is unreachable", async () => {
    // Built at runtime: an unreachable local port, no credentials.
    const unreachable = [["mongodb", "//127.0.0.1:1/x"].join("://"), "serverSelectionTimeoutMS=300"].join("?");
    const result = runScript([], { MONGO_URI: unreachable });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Backfill failed/);
    expect(result.stderr).not.toMatch(/mongodb(\+srv)?:\/\//i);
  });
});
