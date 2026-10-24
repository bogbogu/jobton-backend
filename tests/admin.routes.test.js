import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";

const { default: app } = await import("../app.js");
const { default: User } = await import("../src/models/user.model.js");
const { default: Job } = await import("../src/models/job.model.js");
const { default: TelegramChannel } = await import("../src/models/telegramChannel.model.js");
const { default: TelegramPost } = await import("../src/models/telegramPost.model.js");
const { default: generateToken } = await import("../src/utils/generateToken.js");

let mongoServer;

const createUserWithToken = async ({ role = "user", email = "employer@example.com" } = {}) => {
  const user = await User.create({
    firstName: "Test",
    lastName: "User",
    email,
    password: "$2a$10$eBv3z6r8E0FQn2mM1gM4QeSxwE5jQhTs6f6lJ7mUv7zNli3WfYB0m",
    isVerified: true,
    role,
  });

  return { user, token: generateToken(user._id) };
};

const createAdmin = () => createUserWithToken({ role: "admin", email: "admin@example.com" });

const auth = (token) => ({ Authorization: `Bearer ${token}` });

// A complete job as it would be posted by a normal user (pending review).
const completeJobData = (overrides = {}) => ({
  title: "Senior Product Designer",
  company: "Flutterwave",
  location: "Lagos, Nigeria",
  employmentType: "Full Time",
  salaryMin: 800000,
  category: "Design",
  description: "We are looking for a talented designer.",
  applicationLink: "https://flutterwave.com/careers/123",
  ...overrides,
});

// An ingested job: incomplete on purpose (no company/location/etc.).
const ingestedJobData = (overrides = {}) => ({
  title: "Backend Engineer",
  description: "Build APIs for a fintech.",
  category: "Engineering",
  applyEmail: "jobs@acme.com",
  source: { kind: "telegram", channel: "ngjobsboard", messageId: 101, postedAt: new Date() },
  extraction: { redFlags: ["no_company"], linkClass: "none" },
  ...overrides,
});

const createJob = (data) => Job.create(data);

// The version an admin "looked at": approve requires it as expectedUpdatedAt.
const versionOf = async (job) => (await Job.findById(job._id)).updatedAt.toISOString();

const FAKE_ID = "64b7f0f0f0f0f0f0f0f0f0f0";

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

afterEach(async () => {
  await Job.deleteMany({});
  await User.deleteMany({});
  await TelegramChannel.deleteMany({});
  await TelegramPost.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe("Admin authorization", () => {
  const routes = [
    ["get", "/api/admin/jobs"],
    ["get", `/api/admin/jobs/${FAKE_ID}`],
    ["post", `/api/admin/jobs/${FAKE_ID}/approve`],
    ["post", `/api/admin/jobs/${FAKE_ID}/reject`],
    ["post", "/api/admin/jobs/bulk-reject"],
    ["get", "/api/admin/telegram-channels"],
    ["post", "/api/admin/telegram-channels"],
    ["patch", `/api/admin/telegram-channels/${FAKE_ID}`],
  ];

  it.each(routes)("%s %s returns 401 without a token", async (method, path) => {
    const response = await request(app)[method](path).send({});
    expect(response.status).toBe(401);
  });

  it.each(routes)("%s %s returns 403 for a normal user", async (method, path) => {
    const { token } = await createUserWithToken();
    const response = await request(app)[method](path).set(auth(token)).send({});
    expect(response.status).toBe(403);
  });

  it("allows an admin through every route (never 401/403)", async () => {
    const { token } = await createAdmin();

    for (const [method, path] of routes) {
      const response = await request(app)[method](path).set(auth(token)).send({});
      expect([401, 403]).not.toContain(response.status);
    }
  });

  it("reads the role from the database, not the token", async () => {
    const { user, token } = await createAdmin();
    await User.updateOne({ _id: user._id }, { role: "user" });

    const response = await request(app).get("/api/admin/jobs").set(auth(token));
    expect(response.status).toBe(403);
  });
});

describe("GET /api/admin/jobs", () => {
  it("defaults to pending_review, newest first, with the admin shape", async () => {
    const { token } = await createAdmin();
    const older = await createJob(ingestedJobData({ title: "Older" }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newer = await createJob(ingestedJobData({ title: "Newer" }));
    await createJob(completeJobData({ reviewStatus: "published" }));

    const response = await request(app).get("/api/admin/jobs").set(auth(token));

    expect(response.status).toBe(200);
    expect(response.body.jobs.map((job) => job.id)).toEqual([newer.id, older.id]);
    expect(response.body.pagination).toEqual({ page: 1, limit: 20, total: 2, totalPages: 1 });

    const job = response.body.jobs[0];
    expect(job.reviewStatus).toBe("pending_review");
    expect(job.source).toMatchObject({ kind: "telegram", channel: "ngjobsboard", messageId: 101 });
    expect(job.source.postedAt).toBeTruthy();
    expect(job.extraction).toMatchObject({ redFlags: ["no_company"], linkClass: "none" });
    expect(job.applyEmail).toBe("jobs@acme.com");
    expect(job.createdAt).toBeTruthy();
    expect(job.updatedAt).toBeTruthy();
    expect(job.review).toBeDefined();
  });

  it("filters by reviewStatus, treating legacy jobs without one as published", async () => {
    const { token } = await createAdmin();
    await createJob(ingestedJobData());
    await createJob(completeJobData({ reviewStatus: "published" }));
    await createJob(completeJobData({ reviewStatus: "rejected" }));
    await Job.collection.insertOne({ ...completeJobData({ title: "Legacy" }), createdAt: new Date() });

    const published = await request(app)
      .get("/api/admin/jobs")
      .query({ reviewStatus: "published" })
      .set(auth(token));
    expect(published.body.jobs).toHaveLength(2);
    expect(published.body.jobs.find((job) => job.title === "Legacy").reviewStatus).toBe("published");

    const rejected = await request(app)
      .get("/api/admin/jobs")
      .query({ reviewStatus: "rejected" })
      .set(auth(token));
    expect(rejected.body.jobs).toHaveLength(1);
  });

  it("rejects an unknown reviewStatus or a repeated one with 400", async () => {
    const { token } = await createAdmin();

    const unknown = await request(app)
      .get("/api/admin/jobs")
      .query({ reviewStatus: "draft" })
      .set(auth(token));
    expect(unknown.status).toBe(400);

    const repeated = await request(app)
      .get("/api/admin/jobs?reviewStatus=published&reviewStatus=rejected")
      .set(auth(token));
    expect(repeated.status).toBe(400);
  });

  it("filters by channel and caps the page size at 50", async () => {
    const { token } = await createAdmin();
    await createJob(ingestedJobData({ source: { kind: "telegram", channel: "otherchannel", messageId: 1 } }));
    await createJob(ingestedJobData());

    const byChannel = await request(app)
      .get("/api/admin/jobs")
      .query({ channel: "OtherChannel" })
      .set(auth(token));
    expect(byChannel.body.jobs).toHaveLength(1);
    expect(byChannel.body.jobs[0].source.channel).toBe("otherchannel");

    const capped = await request(app).get("/api/admin/jobs").query({ limit: 500 }).set(auth(token));
    expect(capped.body.pagination.limit).toBe(50);

    const paged = await request(app)
      .get("/api/admin/jobs")
      .query({ limit: 1, page: 2 })
      .set(auth(token));
    expect(paged.body.jobs).toHaveLength(1);
    expect(paged.body.pagination).toMatchObject({ page: 2, limit: 1, total: 2, totalPages: 2 });
  });

  it("ignores non-string channel values instead of failing", async () => {
    const { token } = await createAdmin();
    await createJob(ingestedJobData());

    const response = await request(app)
      .get("/api/admin/jobs?channel=a&channel=b")
      .set(auth(token));
    expect(response.status).toBe(200);
    expect(response.body.jobs).toHaveLength(1);
  });
});

describe("GET /api/admin/jobs/:id", () => {
  it("returns the job with the raw Telegram post", async () => {
    const { token } = await createAdmin();
    const post = await TelegramPost.create({
      channel: "ngjobsboard",
      messageId: 101,
      text: "Hiring a backend engineer! Email jobs@acme.com",
      hasImage: true,
      postedAt: new Date("2026-01-01T00:00:00Z"),
      links: [{ href: "https://acme.com/jobs", label: "Apply" }],
    });
    const job = await createJob(ingestedJobData({ extraction: { post: post._id, linkClass: "none" } }));

    const response = await request(app).get(`/api/admin/jobs/${job.id}`).set(auth(token));

    expect(response.status).toBe(200);
    expect(response.body.job.id).toBe(job.id);
    expect(response.body.job.extraction.post).toBe(post.id);
    expect(response.body.rawPost).toMatchObject({
      text: "Hiring a backend engineer! Email jobs@acme.com",
      hasImage: true,
      links: [{ href: "https://acme.com/jobs", label: "Apply" }],
    });
    expect(response.body.rawPost.postedAt).toBeTruthy();
  });

  it("returns rawPost null when the post was purged or never existed", async () => {
    const { token } = await createAdmin();
    const purged = await createJob(ingestedJobData({ extraction: { post: FAKE_ID } }));
    const plain = await createJob(completeJobData());

    const first = await request(app).get(`/api/admin/jobs/${purged.id}`).set(auth(token));
    expect(first.status).toBe(200);
    expect(first.body.rawPost).toBeNull();

    const second = await request(app).get(`/api/admin/jobs/${plain.id}`).set(auth(token));
    expect(second.body.rawPost).toBeNull();
  });

  it("returns 404 for an invalid or unknown id", async () => {
    const { token } = await createAdmin();

    expect((await request(app).get("/api/admin/jobs/not-an-id").set(auth(token))).status).toBe(404);
    expect((await request(app).get(`/api/admin/jobs/${FAKE_ID}`).set(auth(token))).status).toBe(404);
  });
});

describe("POST /api/admin/jobs/:id/approve", () => {
  it("publishes a complete pending job, records the reviewer, and makes it public", async () => {
    const { user, token } = await createAdmin();
    const job = await createJob(completeJobData());
    expect(job.reviewStatus).toBe("pending_review");

    const before = await request(app).get("/api/jobs");
    expect(before.body.jobs.map((item) => item.id)).not.toContain(job.id);

    const response = await request(app)
      .post(`/api/admin/jobs/${job.id}/approve`)
      .set(auth(token))
      .send({ expectedUpdatedAt: await versionOf(job) });

    expect(response.status).toBe(200);
    expect(response.body.job.reviewStatus).toBe("published");
    expect(response.body.job.review.reviewedBy).toBe(user.id);
    expect(response.body.job.review.reviewedAt).toBeTruthy();

    const after = await request(app).get("/api/jobs");
    expect(after.body.jobs.map((item) => item.id)).toContain(job.id);
  });

  it("applies edits that fix an incomplete ingested job", async () => {
    const { token } = await createAdmin();
    const job = await createJob(ingestedJobData());

    const response = await request(app)
      .post(`/api/admin/jobs/${job.id}/approve`)
      .set(auth(token))
      .send({
        expectedUpdatedAt: await versionOf(job),
        edits: {
          company: "Acme Ltd",
          location: "Abuja",
          employmentType: "Contract",
          skills: ["Node.js", "MongoDB"],
        },
      });

    expect(response.status).toBe(200);
    expect(response.body.job).toMatchObject({
      company: "Acme Ltd",
      location: "Abuja",
      type: "Contract",
      skills: ["Node.js", "MongoDB"],
      reviewStatus: "published",
    });

    const stored = await Job.findById(job._id);
    expect(stored.company).toBe("Acme Ltd");
    expect(stored.reviewStatus).toBe("published");
    // Provenance is preserved.
    expect(stored.source.channel).toBe("ngjobsboard");
  });

  it("returns 400 MISSING_FIELDS listing what is missing", async () => {
    const { token } = await createAdmin();
    const job = await createJob(ingestedJobData());

    const response = await request(app)
      .post(`/api/admin/jobs/${job.id}/approve`)
      .set(auth(token))
      .send({ expectedUpdatedAt: await versionOf(job), edits: { location: "Abuja" } });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("MISSING_FIELDS");
    expect(response.body.missing).toContain("company");
    expect(response.body.missing).not.toContain("location");

    expect((await Job.findById(job._id)).reviewStatus).toBe("pending_review");
  });

  it("requires at least one way to apply", async () => {
    const { token } = await createAdmin();
    const job = await createJob(
      ingestedJobData({ company: "Acme", location: "Abuja", applyEmail: undefined })
    );

    const response = await request(app)
      .post(`/api/admin/jobs/${job.id}/approve`)
      .set(auth(token))
      .send({ expectedUpdatedAt: await versionOf(job) });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("MISSING_FIELDS");
    expect(response.body.missing).toContain("applyContact");
  });

  it("rejects javascript: links, bad emails and bad phones in edits", async () => {
    const { token } = await createAdmin();
    const job = await createJob(ingestedJobData({ company: "Acme", location: "Abuja" }));

    for (const edits of [
      { applicationLink: "javascript:alert(1)" },
      { applicationLink: "data:text/html,<script>1</script>" },
      { applyEmail: "not-an-email" },
      { applyPhone: "abc" },
      { employmentType: "Slave Labour" },
    ]) {
      const response = await request(app)
        .post(`/api/admin/jobs/${job.id}/approve`)
        .set(auth(token))
        .send({ expectedUpdatedAt: await versionOf(job), edits });

      expect(response.status).toBe(400);
      expect(response.body.error).not.toBe("EXPECTED_UPDATED_AT_REQUIRED");
    }

    expect((await Job.findById(job._id)).reviewStatus).toBe("pending_review");
  });

  it("ignores mass-assignment of protected fields in edits", async () => {
    const { user, token } = await createAdmin();
    const { user: other } = await createUserWithToken({ email: "other@example.com" });
    const job = await createJob(ingestedJobData({ company: "Acme", location: "Abuja" }));

    const response = await request(app)
      .post(`/api/admin/jobs/${job.id}/approve`)
      .set(auth(token))
      .send({
        expectedUpdatedAt: await versionOf(job),
        edits: {
          title: "Edited Title",
          reviewStatus: "rejected",
          source: { kind: "telegram", channel: "evil", messageId: 9 },
          extraction: { redFlags: [] },
          review: { reviewedBy: other.id },
          dedupeKey: "hacked",
          postedBy: other.id,
          applicants: 9999,
          status: ["verified"],
        },
      });

    expect(response.status).toBe(200);

    const stored = await Job.findById(job._id);
    expect(stored.title).toBe("Edited Title");
    expect(stored.reviewStatus).toBe("published");
    expect(stored.source.channel).toBe("ngjobsboard");
    expect(stored.extraction.redFlags).toEqual(["no_company"]);
    expect(stored.review.reviewedBy.toString()).toBe(user.id);
    expect(stored.dedupeKey).toBeUndefined();
    expect(stored.postedBy).toBeNull();
    expect(stored.applicants).toBe(0);
    expect(stored.status).toEqual([]);
  });

  it("sets badges only through the admin body.status, validated against the enum", async () => {
    const { token } = await createAdmin();
    const job = await createJob(ingestedJobData({ company: "Acme", location: "Abuja" }));

    const invalid = await request(app)
      .post(`/api/admin/jobs/${job.id}/approve`)
      .set(auth(token))
      .send({ expectedUpdatedAt: await versionOf(job), status: ["superstar"] });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toBe("INVALID_STATUS");

    const notArray = await request(app)
      .post(`/api/admin/jobs/${job.id}/approve`)
      .set(auth(token))
      .send({ expectedUpdatedAt: await versionOf(job), status: "verified" });
    expect(notArray.status).toBe(400);
    expect(notArray.body.error).toBe("INVALID_STATUS");

    const response = await request(app)
      .post(`/api/admin/jobs/${job.id}/approve`)
      .set(auth(token))
      .send({
        expectedUpdatedAt: await versionOf(job),
        status: ["verified", "verified", "urgent"],
      });
    expect(response.status).toBe(200);
    expect(response.body.job.status).toEqual(["verified", "urgent"]);
  });

  it("returns 409 NOT_PENDING on a second approve and on approve-after-reject", async () => {
    const { token } = await createAdmin();
    const approved = await createJob(completeJobData());
    const rejected = await createJob(completeJobData({ title: "Other" }));

    const first = await request(app)
      .post(`/api/admin/jobs/${approved.id}/approve`)
      .set(auth(token))
      .send({ expectedUpdatedAt: await versionOf(approved) });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post(`/api/admin/jobs/${approved.id}/approve`)
      .set(auth(token))
      .send({ expectedUpdatedAt: await versionOf(approved) });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("NOT_PENDING");

    await request(app).post(`/api/admin/jobs/${rejected.id}/reject`).set(auth(token)).send({});
    const afterReject = await request(app)
      .post(`/api/admin/jobs/${rejected.id}/approve`)
      .set(auth(token))
      .send({ expectedUpdatedAt: await versionOf(rejected) });
    expect(afterReject.status).toBe(409);
    expect(afterReject.body.error).toBe("NOT_PENDING");
    expect((await Job.findById(rejected._id)).reviewStatus).toBe("rejected");
  });

  it("publishes exactly once when two approvals race", async () => {
    const { token } = await createAdmin();
    const job = await createJob(completeJobData());

    const body = { expectedUpdatedAt: await versionOf(job) };

    const results = await Promise.all([
      request(app).post(`/api/admin/jobs/${job.id}/approve`).set(auth(token)).send(body),
      request(app).post(`/api/admin/jobs/${job.id}/approve`).set(auth(token)).send(body),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
  });

  it("returns 404 for an invalid or unknown id and 400 for a malformed edits body", async () => {
    const { token } = await createAdmin();

    const expectedUpdatedAt = new Date().toISOString();

    // An invalid id is a 404 even without the required expectedUpdatedAt.
    expect(
      (await request(app).post("/api/admin/jobs/nope/approve").set(auth(token)).send({})).status
    ).toBe(404);
    expect(
      (
        await request(app)
          .post(`/api/admin/jobs/${FAKE_ID}/approve`)
          .set(auth(token))
          .send({ expectedUpdatedAt })
      ).status
    ).toBe(404);

    const job = await createJob(completeJobData());
    const response = await request(app)
      .post(`/api/admin/jobs/${job.id}/approve`)
      .set(auth(token))
      .send({ expectedUpdatedAt: await versionOf(job), edits: ["company"] });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("INVALID_EDITS");
  });

  it("requires expectedUpdatedAt: 400 EXPECTED_UPDATED_AT_REQUIRED when missing or null, job untouched", async () => {
    const { token } = await createAdmin();
    const job = await createJob(completeJobData());

    for (const body of [{}, { expectedUpdatedAt: null }, { edits: { category: "Design" } }]) {
      const response = await request(app)
        .post(`/api/admin/jobs/${job.id}/approve`)
        .set(auth(token))
        .send(body);

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("EXPECTED_UPDATED_AT_REQUIRED");
    }

    // No body at all behaves the same.
    const noBody = await request(app).post(`/api/admin/jobs/${job.id}/approve`).set(auth(token));
    expect(noBody.status).toBe(400);
    expect(noBody.body.error).toBe("EXPECTED_UPDATED_AT_REQUIRED");

    const stored = await Job.findById(job._id);
    expect(stored.reviewStatus).toBe("pending_review");
    expect(stored.review?.reviewedBy ?? null).toBeNull();
  });

  it("publishes with the current expectedUpdatedAt and returns 409 STALE for an old one", async () => {
    const { token } = await createAdmin();
    const job = await createJob(completeJobData());
    const reviewed = await versionOf(job);

    // An owner edit lands after the admin opened the job.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await Job.findOneAndUpdate({ _id: job._id }, { $set: { title: "Edited by owner" } });
    expect(await versionOf(job)).not.toBe(reviewed);

    const stale = await request(app)
      .post(`/api/admin/jobs/${job.id}/approve`)
      .set(auth(token))
      .send({ expectedUpdatedAt: reviewed });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe("STALE");
    expect((await Job.findById(job._id)).reviewStatus).toBe("pending_review");

    const unparseable = await request(app)
      .post(`/api/admin/jobs/${job.id}/approve`)
      .set(auth(token))
      .send({ expectedUpdatedAt: "not-a-date" });
    expect(unparseable.status).toBe(409);
    expect(unparseable.body.error).toBe("STALE");

    const fresh = await request(app)
      .post(`/api/admin/jobs/${job.id}/approve`)
      .set(auth(token))
      .send({ expectedUpdatedAt: await versionOf(job) });
    expect(fresh.status).toBe(200);
    expect(fresh.body.job.reviewStatus).toBe("published");
    expect(fresh.body.job.title).toBe("Edited by owner");
  });
});

describe("POST /api/admin/jobs/:id/reject", () => {
  it("rejects a pending job and stores the reason and reviewer", async () => {
    const { user, token } = await createAdmin();
    const job = await createJob(ingestedJobData());

    const response = await request(app)
      .post(`/api/admin/jobs/${job.id}/reject`)
      .set(auth(token))
      .send({ reason: "Looks like an advance-fee scam" });

    expect(response.status).toBe(200);
    expect(response.body.job.reviewStatus).toBe("rejected");
    expect(response.body.job.review).toMatchObject({
      reviewedBy: user.id,
      rejectionReason: "Looks like an advance-fee scam",
    });
  });

  it("allows a reject without a reason and rejects bad reasons", async () => {
    const { token } = await createAdmin();
    const job = await createJob(ingestedJobData());

    const tooLong = await request(app)
      .post(`/api/admin/jobs/${job.id}/reject`)
      .set(auth(token))
      .send({ reason: "x".repeat(501) });
    expect(tooLong.status).toBe(400);

    const wrongType = await request(app)
      .post(`/api/admin/jobs/${job.id}/reject`)
      .set(auth(token))
      .send({ reason: { $gt: "" } });
    expect(wrongType.status).toBe(400);

    const ok = await request(app).post(`/api/admin/jobs/${job.id}/reject`).set(auth(token)).send({});
    expect(ok.status).toBe(200);
  });

  it("returns 409 NOT_PENDING when already reviewed and 404 for unknown ids", async () => {
    const { token } = await createAdmin();
    const job = await createJob(completeJobData({ reviewStatus: "published" }));

    const conflict = await request(app)
      .post(`/api/admin/jobs/${job.id}/reject`)
      .set(auth(token))
      .send({});
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe("NOT_PENDING");
    expect((await Job.findById(job._id)).reviewStatus).toBe("published");

    expect(
      (await request(app).post("/api/admin/jobs/nope/reject").set(auth(token)).send({})).status
    ).toBe(404);
    expect(
      (await request(app).post(`/api/admin/jobs/${FAKE_ID}/reject`).set(auth(token)).send({})).status
    ).toBe(404);
  });

  it("keeps rejected jobs out of the public list and detail", async () => {
    const { token } = await createAdmin();
    const job = await createJob(completeJobData());

    await request(app).post(`/api/admin/jobs/${job.id}/reject`).set(auth(token)).send({});

    const list = await request(app).get("/api/jobs");
    expect(list.body.jobs.map((item) => item.id)).not.toContain(job.id);

    const detail = await request(app).get(`/api/jobs/${job.id}`);
    expect(detail.status).toBe(404);
  });
});

describe("POST /api/admin/jobs/bulk-reject", () => {
  it("rejects only the pending jobs and reports the count", async () => {
    const { user, token } = await createAdmin();
    const pendingA = await createJob(ingestedJobData());
    const pendingB = await createJob(ingestedJobData({ title: "Second" }));
    const published = await createJob(completeJobData({ reviewStatus: "published" }));

    const response = await request(app)
      .post("/api/admin/jobs/bulk-reject")
      .set(auth(token))
      .send({ ids: [pendingA.id, pendingB.id, published.id, FAKE_ID, pendingA.id], reason: "Spam" });

    expect(response.status).toBe(200);
    expect(response.body.rejected).toBe(2);

    const storedA = await Job.findById(pendingA._id);
    expect(storedA.reviewStatus).toBe("rejected");
    expect(storedA.review.rejectionReason).toBe("Spam");
    expect(storedA.review.reviewedBy.toString()).toBe(user.id);
    expect((await Job.findById(published._id)).reviewStatus).toBe("published");
  });

  it("returns 400 for non-arrays, empty or oversized lists and invalid ids", async () => {
    const { token } = await createAdmin();
    const send = (body) =>
      request(app).post("/api/admin/jobs/bulk-reject").set(auth(token)).send(body);

    expect((await send({})).status).toBe(400);
    expect((await send({ ids: FAKE_ID })).status).toBe(400);
    expect((await send({ ids: [] })).status).toBe(400);
    expect((await send({ ids: Array(101).fill(FAKE_ID) })).status).toBe(400);
    expect((await send({ ids: [FAKE_ID, "not-an-id"] })).status).toBe(400);
    expect((await send({ ids: [{ $ne: null }] })).status).toBe(400);
    // 12-character strings are "valid" for ObjectId.isValid but are not ids.
    expect((await send({ ids: ["abcdefghijkl"] })).status).toBe(400);
    expect((await send({ ids: [FAKE_ID], reason: 5 })).status).toBe(400);
  });

  it("accepts exactly 100 ids", async () => {
    const { token } = await createAdmin();

    const response = await request(app)
      .post("/api/admin/jobs/bulk-reject")
      .set(auth(token))
      .send({ ids: Array.from({ length: 100 }, () => new mongoose.Types.ObjectId().toString()) });

    expect(response.status).toBe(200);
    expect(response.body.rejected).toBe(0);
  });
});

describe("Verified badge", () => {
  it("cannot be self-assigned by a user and is only granted by admin approval", async () => {
    const { token: userToken } = await createUserWithToken();
    const { token: adminToken } = await createAdmin();

    const created = await request(app)
      .post("/api/jobs")
      .set(auth(userToken))
      .send({ ...completeJobData(), status: ["verified"] });

    // Whatever the create endpoint does with it, the badge must not make the
    // job public: it is still waiting for review.
    if (created.status === 201) {
      const stored = await Job.findById(created.body.job.id);
      expect(stored.reviewStatus).toBe("pending_review");
      expect(stored.status).not.toContain("verified");

      const approved = await request(app)
        .post(`/api/admin/jobs/${stored.id}/approve`)
        .set(auth(adminToken))
        .send({ expectedUpdatedAt: await versionOf(stored), status: ["verified"] });
      expect(approved.status).toBe(200);
      expect((await Job.findById(stored._id)).status).toContain("verified");
    }
  });
});

describe("Telegram channels", () => {
  it("normalizes @name, bare, and t.me URL forms to a lowercase username", async () => {
    const { user, token } = await createAdmin();
    const inputs = [
      ["@NgJobsBoard", "ngjobsboard"],
      ["Remote_Work_NG", "remote_work_ng"],
      ["https://t.me/Lagos_Jobs", "lagos_jobs"],
      ["t.me/abuja_jobs/", "abuja_jobs"],
      ["  http://www.telegram.me/kano_jobs  ", "kano_jobs"],
    ];

    for (const [input, expected] of inputs) {
      const response = await request(app)
        .post("/api/admin/telegram-channels")
        .set(auth(token))
        .send({ username: input });

      expect(response.status).toBe(201);
      expect(response.body.channel).toMatchObject({
        username: expected,
        kind: "board",
        active: true,
        addedBy: user.id,
      });
    }
  });

  it("accepts a kind and rejects an invalid one", async () => {
    const { token } = await createAdmin();

    const ok = await request(app)
      .post("/api/admin/telegram-channels")
      .set(auth(token))
      .send({ username: "editorial_ng", kind: "authored" });
    expect(ok.status).toBe(201);
    expect(ok.body.channel.kind).toBe("authored");

    const bad = await request(app)
      .post("/api/admin/telegram-channels")
      .set(auth(token))
      .send({ username: "another_one", kind: "weird" });
    expect(bad.status).toBe(400);
  });

  it("rejects invalid usernames with 400", async () => {
    const { token } = await createAdmin();
    const invalid = [
      "../x",
      "../../etc/passwd",
      "has space",
      "abcd", // too short
      "a".repeat(33), // too long
      "1startsdigit",
      "bad-dash_name",
      "https://evil.com/channel",
      "@@doubleat",
      "",
      "   ",
      123,
      null,
      ["ngjobsboard"],
      { $ne: null },
    ];

    for (const username of invalid) {
      const response = await request(app)
        .post("/api/admin/telegram-channels")
        .set(auth(token))
        .send({ username });
      expect(response.status, JSON.stringify(username)).toBe(400);
    }

    expect(
      (await request(app).post("/api/admin/telegram-channels").set(auth(token)).send({})).status
    ).toBe(400);
    expect(await TelegramChannel.countDocuments()).toBe(0);
  });

  it("returns 409 for a duplicate, including a differently-written form", async () => {
    const { token } = await createAdmin();

    await request(app).post("/api/admin/telegram-channels").set(auth(token)).send({ username: "ngjobsboard" });
    const duplicate = await request(app)
      .post("/api/admin/telegram-channels")
      .set(auth(token))
      .send({ username: "https://t.me/NgJobsBoard" });

    expect(duplicate.status).toBe(409);
    expect(await TelegramChannel.countDocuments()).toBe(1);
  });

  it("lists channels with poll stats and job counts per review status", async () => {
    const { token } = await createAdmin();
    await TelegramChannel.create({
      username: "ngjobsboard",
      lastMessageId: 55,
      consecutiveFailures: 2,
      lastError: "fetch failed",
      lastPolledAt: new Date(),
    });
    await TelegramChannel.create({ username: "quiet_channel", active: false, kind: "authored" });

    await createJob(ingestedJobData());
    await createJob(ingestedJobData({ title: "Two" }));
    await createJob(ingestedJobData({ title: "Rejected", reviewStatus: "rejected" }));
    await Job.collection.insertOne({
      ...completeJobData(),
      source: { kind: "telegram", channel: "ngjobsboard", messageId: 3 },
    });

    const response = await request(app).get("/api/admin/telegram-channels").set(auth(token));

    expect(response.status).toBe(200);
    expect(response.body.channels).toHaveLength(2);

    const board = response.body.channels.find((channel) => channel.username === "ngjobsboard");
    expect(board).toMatchObject({
      lastMessageId: 55,
      consecutiveFailures: 2,
      lastError: "fetch failed",
      active: true,
      kind: "board",
      jobCounts: { pending_review: 2, published: 1, rejected: 1 },
    });
    expect(board.lastPolledAt).toBeTruthy();

    const quiet = response.body.channels.find((channel) => channel.username === "quiet_channel");
    expect(quiet).toMatchObject({
      active: false,
      kind: "authored",
      jobCounts: { pending_review: 0, published: 0, rejected: 0 },
    });
  });

  it("PATCH changes only active and kind", async () => {
    const { token } = await createAdmin();
    const channel = await TelegramChannel.create({ username: "ngjobsboard", lastMessageId: 7 });

    const response = await request(app)
      .patch(`/api/admin/telegram-channels/${channel.id}`)
      .set(auth(token))
      .send({
        active: false,
        kind: "authored",
        username: "hijacked_name",
        lastMessageId: 0,
        consecutiveFailures: 99,
        lastError: "x",
      });

    expect(response.status).toBe(200);
    expect(response.body.channel).toMatchObject({ active: false, kind: "authored" });

    const stored = await TelegramChannel.findById(channel._id);
    expect(stored.username).toBe("ngjobsboard");
    expect(stored.lastMessageId).toBe(7);
    expect(stored.consecutiveFailures).toBe(0);
    expect(stored.lastError).toBeUndefined();
  });

  it("PATCH validates input and returns 404 for invalid or unknown ids", async () => {
    const { token } = await createAdmin();
    const channel = await TelegramChannel.create({ username: "ngjobsboard" });
    const patch = (id, body) =>
      request(app).patch(`/api/admin/telegram-channels/${id}`).set(auth(token)).send(body);

    expect((await patch(channel.id, { active: "yes" })).status).toBe(400);
    expect((await patch(channel.id, { kind: "weird" })).status).toBe(400);
    expect((await patch(channel.id, { username: "other_name" })).status).toBe(400);
    expect((await patch("nope", { active: false })).status).toBe(404);
    expect((await patch(FAKE_ID, { active: false })).status).toBe(404);
  });

  it("does not expose a DELETE route", async () => {
    const { token } = await createAdmin();
    const channel = await TelegramChannel.create({ username: "ngjobsboard" });

    const response = await request(app)
      .delete(`/api/admin/telegram-channels/${channel.id}`)
      .set(auth(token));

    expect(response.status).toBe(404);
    expect(await TelegramChannel.countDocuments()).toBe(1);
  });
});
