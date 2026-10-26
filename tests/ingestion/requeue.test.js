import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import TelegramPost from "../../src/models/telegramPost.model.js";
import {
  imagesDisabledError,
  parseRequeueArgs,
  runRequeue,
  selectRequeueCandidates,
} from "../../src/services/ingestion/requeueImagePosts.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DB_NAME = "requeue_script_db";
const photo = (name) => `https://cdn4.telesco.pe/file/${name}.jpg`;

let mongoServer;
let uri;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  uri = mongoServer.getUri(DB_NAME);
  await mongoose.connect(uri);
  await TelegramPost.init();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await TelegramPost.deleteMany({});
});

let nextId = 1;
// Raw insert: older posts must be creatable without the new field, and the
// selection must not depend on schema defaults.
const insertPost = async (fields = {}) => {
  const messageId = nextId++;
  const doc = {
    channel: "flyers_ng",
    messageId,
    text: "",
    hasImage: true,
    links: [],
    status: "skipped",
    error: "No text.",
    attempts: 2,
    fetchedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...fields,
  };
  await TelegramPost.collection.insertOne(doc);
  return messageId;
};

const seed = async () => ({
  eligible: await insertPost({ imageUrls: [photo("a")] }),
  eligibleTwo: await insertPost({ imageUrls: [photo("b"), photo("c")] }),
  legacy: await insertPost({}),
  legacyEmpty: await insertPost({ imageUrls: [] }),
  hostileOnly: await insertPost({ imageUrls: ["https://evil.example/x.jpg"] }),
  noImage: await insertPost({ hasImage: false, imageUrls: [] }),
  otherError: await insertPost({ error: "Text too short.", imageUrls: [photo("d")] }),
  failed: await insertPost({ status: "failed", imageUrls: [photo("e")] }),
  extracted: await insertPost({ status: "extracted", error: undefined, imageUrls: [photo("f")] }),
  unreadable: await insertPost({ error: "No readable text in image.", imageUrls: [photo("g")] }),
});

const statusOf = async (messageId) => TelegramPost.findOne({ messageId }).lean();

describe("selectRequeueCandidates", () => {
  it("picks only skipped 'No text.' image posts with an allow-listed URL, and counts the older ones", async () => {
    const ids = await seed();
    const { requeueable, withoutUrls } = await selectRequeueCandidates();

    const picked = await TelegramPost.find({ _id: { $in: requeueable } }).lean();
    expect(picked.map((post) => post.messageId).sort((a, b) => a - b)).toEqual([ids.eligible, ids.eligibleTwo]);
    // legacy (no field) and legacyEmpty ([]) can only be counted.
    expect(withoutUrls).toBe(2);
  });
});

describe("runRequeue", () => {
  it("dry run changes nothing", async () => {
    const ids = await seed();
    const summary = await runRequeue({ apply: false });

    expect(summary).toEqual({ mode: "dry-run", candidates: 2, withoutStoredUrls: 2, requeued: 0 });
    expect(await statusOf(ids.eligible)).toMatchObject({ status: "skipped", error: "No text." });
  });

  it("apply resets only the eligible posts to new, without an error, keeping everything else", async () => {
    const ids = await seed();
    const summary = await runRequeue({ apply: true });

    expect(summary).toEqual({ mode: "apply", candidates: 2, withoutStoredUrls: 2, requeued: 2 });

    for (const id of [ids.eligible, ids.eligibleTwo]) {
      const post = await statusOf(id);
      expect(post.status).toBe("new");
      expect(post.error).toBeUndefined();
      expect(post.attempts).toBe(0);
    }
    for (const id of [ids.legacy, ids.legacyEmpty, ids.hostileOnly, ids.unreadable]) {
      expect((await statusOf(id)).status).toBe("skipped");
    }
    expect((await statusOf(ids.noImage)).status).toBe("skipped");
    expect(await statusOf(ids.otherError)).toMatchObject({ status: "skipped", error: "Text too short." });
    expect((await statusOf(ids.failed)).status).toBe("failed");
    expect((await statusOf(ids.extracted)).status).toBe("extracted");
  });

  it("is idempotent: a second apply finds nothing left to re-queue", async () => {
    await seed();
    await runRequeue({ apply: true });
    const again = await runRequeue({ apply: true });
    expect(again).toMatchObject({ candidates: 0, requeued: 0 });
  });

  it("is conditional: a post that changed state after selection is not touched", async () => {
    const id = await insertPost({ imageUrls: [photo("race")] });
    const { requeueable } = await selectRequeueCandidates();
    await TelegramPost.updateOne({ messageId: id }, { status: "extracted" });

    const result = await TelegramPost.updateMany(
      { _id: { $in: requeueable }, hasImage: true, status: "skipped", error: "No text." },
      { $set: { status: "new" } }
    );
    expect(result.modifiedCount).toBe(0);
  });
});

describe("arguments and guards", () => {
  it("parses --apply and --yes-db and rejects anything else", () => {
    expect(parseRequeueArgs([])).toEqual({ apply: false, yesDb: undefined });
    expect(parseRequeueArgs(["--apply", "--yes-db=somedb"])).toEqual({ apply: true, yesDb: "somedb" });
    expect(() => parseRequeueArgs(["--force"])).toThrow(/Unknown argument/);
  });

  it("refuses unless INGESTION_IMAGES_ENABLED is exactly 'true'", () => {
    expect(imagesDisabledError({})).toMatch(/INGESTION_IMAGES_ENABLED/);
    expect(imagesDisabledError({ INGESTION_IMAGES_ENABLED: "TRUE" })).toBeTruthy();
    expect(imagesDisabledError({ INGESTION_IMAGES_ENABLED: "false" })).toBeTruthy();
    expect(imagesDisabledError({ INGESTION_IMAGES_ENABLED: "true" })).toBeNull();
  });
});

describe("scripts/requeue-image-posts.js", () => {
  const runScript = (args, env = {}) =>
    spawnSync(process.execPath, ["scripts/requeue-image-posts.js", ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 60000,
      env: { ...process.env, MONGO_URI: uri, INGESTION_IMAGES_ENABLED: "true", ...env },
    });

  const summaryOf = (result) => JSON.parse(result.stdout.trim().split("\n").pop());

  it("refuses to run without INGESTION_IMAGES_ENABLED=true and touches nothing", async () => {
    const ids = await seed();
    const result = runScript(["--apply", `--yes-db=${DB_NAME}`], { INGESTION_IMAGES_ENABLED: "" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("INGESTION_IMAGES_ENABLED");
    expect((await statusOf(ids.eligible)).status).toBe("skipped");
  });

  it("dry run prints host and db, counts only, and writes nothing", async () => {
    const ids = await seed();
    const result = runScript([]);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(`db=${DB_NAME}`);
    expect(summaryOf(result)).toEqual({ db: DB_NAME, mode: "dry-run", candidates: 2, withoutStoredUrls: 2, requeued: 0 });
    expect((await statusOf(ids.eligible)).status).toBe("skipped");
  });

  it("--apply needs --yes-db and it must match the connected database", async () => {
    const ids = await seed();

    const missing = runScript(["--apply"]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("--yes-db");

    const wrong = runScript(["--apply", "--yes-db=some_other_db"]);
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toContain("does not match");
    expect((await statusOf(ids.eligible)).status).toBe("skipped");
  });

  it("--apply with the right database re-queues, and prints no credentials", async () => {
    const ids = await seed();
    const result = runScript(["--apply", `--yes-db=${DB_NAME}`]);

    expect(result.status).toBe(0);
    expect(summaryOf(result)).toMatchObject({ db: DB_NAME, mode: "apply", requeued: 2 });
    expect((await statusOf(ids.eligible)).status).toBe("new");
    expect(`${result.stdout}${result.stderr}`).not.toContain(uri);
  });
});
