import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from "vitest";

const { default: app } = await import("../app.js");
const { default: User } = await import("../src/models/user.model.js");
const { default: Job } = await import("../src/models/job.model.js");
const { default: generateToken } = await import("../src/utils/generateToken.js");
const { default: SavedJob } = await import("../src/models/savedJob.model.js");
const { getConfig } = await import("../src/services/ingestion/config.js");

let mongoServer;

const createUserWithToken = async ({ role = "user", email = "owner@example.com" } = {}) => {
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

const auth = (token) => ({ Authorization: `Bearer ${token}` });

const jobData = (overrides = {}) => ({
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

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Job.deleteMany({});
  await User.deleteMany({});
  await SavedJob.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe("review-gate races", () => {
  it("an owner edit that races with an admin approval still ends up pending_review", async () => {
    const { user, token } = await createUserWithToken();
    const job = await Job.create(jobData({ postedBy: user._id, reviewStatus: "pending_review" }));

    // Simulate the admin approving AFTER the owner's request loaded the job
    // (still pending) but BEFORE the owner's save lands.
    const realSave = Job.prototype.save;
    vi.spyOn(Job.prototype, "save").mockImplementationOnce(async function (...args) {
      await Job.collection.updateOne({ _id: this._id }, { $set: { reviewStatus: "published" } });
      return realSave.apply(this, args);
    });

    const response = await request(app)
      .patch(`/api/jobs/${job._id}`)
      .set(auth(token))
      .send({ applicationLink: "https://changed.example.com/apply" });

    expect(response.status).toBe(200);

    const stored = await Job.collection.findOne({ _id: job._id });
    expect(stored.reviewStatus).toBe("pending_review");
    expect(stored.applicationLink).toBe("https://changed.example.com/apply");

    const publicList = await request(app).get("/api/jobs");
    expect(publicList.body.jobs).toHaveLength(0);
  });

  it("a rejected job stays rejected when its owner edits it", async () => {
    const { user, token } = await createUserWithToken();
    const job = await Job.create(jobData({ postedBy: user._id, reviewStatus: "rejected" }));

    const response = await request(app)
      .patch(`/api/jobs/${job._id}`)
      .set(auth(token))
      .send({ title: "Edited title" });

    expect(response.status).toBe(200);
    expect((await Job.collection.findOne({ _id: job._id })).reviewStatus).toBe("rejected");
  });

  it("approve is refused (STALE) when the job changed after the admin loaded it", async () => {
    const { token: adminToken } = await createUserWithToken({ role: "admin", email: "admin@example.com" });
    const job = await Job.create(jobData({ reviewStatus: "pending_review" }));

    const realFindOneAndUpdate = Job.findOneAndUpdate.bind(Job);
    vi.spyOn(Job, "findOneAndUpdate").mockImplementationOnce(async (...args) => {
      // owner edit lands between the admin's read and the admin's write
      await Job.collection.updateOne(
        { _id: job._id },
        { $set: { applicationLink: "https://evil.example.com", updatedAt: new Date(Date.now() + 5000) } }
      );
      return realFindOneAndUpdate(...args);
    });

    const response = await request(app)
      .post(`/api/admin/jobs/${job._id}/approve`)
      .set(auth(adminToken))
      .send({});

    expect(response.status).toBe(409);
    expect(response.body.error).toBe("STALE");
    expect((await Job.collection.findOne({ _id: job._id })).reviewStatus).toBe("pending_review");
  });

  it("approve with a stale expectedUpdatedAt returns 409 STALE; with the current one it publishes", async () => {
    const { token: adminToken } = await createUserWithToken({ role: "admin", email: "admin@example.com" });
    const job = await Job.create(jobData({ reviewStatus: "pending_review" }));

    const stale = await request(app)
      .post(`/api/admin/jobs/${job._id}/approve`)
      .set(auth(adminToken))
      .send({ expectedUpdatedAt: new Date(job.updatedAt.getTime() - 60_000).toISOString() });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe("STALE");

    const ok = await request(app)
      .post(`/api/admin/jobs/${job._id}/approve`)
      .set(auth(adminToken))
      .send({ expectedUpdatedAt: job.updatedAt.toISOString() });
    expect(ok.status).toBe(200);
    expect(ok.body.job.reviewStatus).toBe("published");
  });
});

describe("shared filter and legacy data", () => {
  it("GET /api/admin/jobs?reviewStatus=published&channel=x works (shared filter object is not mutated)", async () => {
    const { token: adminToken } = await createUserWithToken({ role: "admin", email: "admin@example.com" });
    await Job.create(
      jobData({
        reviewStatus: "published",
        source: { kind: "telegram", channel: "ngjobsboard", messageId: 1 },
      })
    );

    for (let i = 0; i < 2; i += 1) {
      const response = await request(app)
        .get("/api/admin/jobs?reviewStatus=published&channel=ngjobsboard")
        .set(auth(adminToken));
      expect(response.status).toBe(200);
      expect(response.body.jobs).toHaveLength(1);
    }

    // And the public list is unaffected by the earlier admin query.
    const publicList = await request(app).get("/api/jobs");
    expect(publicList.status).toBe(200);
    expect(publicList.body.jobs).toHaveLength(1);
  });

  it("a legacy job holding an invalid stored domain can still be edited (only modified fields are validated)", async () => {
    const { token: adminToken } = await createUserWithToken({ role: "admin", email: "admin@example.com" });
    const now = new Date();
    const { insertedId } = await Job.collection.insertOne({
      ...jobData(),
      domain: "not a valid domain!!",
      logoUrl: "javascript:alert(1)",
      skills: [],
      responsibilities: [],
      status: [],
      salaryCurrency: "NGN",
      salaryPeriod: "month",
      applicants: 0,
      createdAt: now,
      updatedAt: now,
    });

    const response = await request(app)
      .patch(`/api/jobs/${insertedId}`)
      .set(auth(adminToken))
      .send({ title: "Renamed legacy job" });

    expect(response.status).toBe(200);
    expect(response.body.job.title).toBe("Renamed legacy job");
    // still no reviewStatus written: legacy stays public
    expect((await Job.collection.findOne({ _id: insertedId })).reviewStatus).toBeUndefined();
  });

  it("a non-numeric salary is a clean 400 that names the field", async () => {
    const { token } = await createUserWithToken({ role: "admin", email: "admin@example.com" });

    const response = await request(app)
      .post("/api/jobs")
      .set(auth(token))
      .send(jobData({ salaryMin: "not-a-number" }));

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/salaryMin/);
    expect(response.body.stack).toBeUndefined();
  });
});

describe("saved jobs pagination", () => {
  it("pages and totals count only visible saved jobs", async () => {
    const { user, token } = await createUserWithToken();
    const visible = [];
    for (let i = 0; i < 3; i += 1) {
      visible.push(await Job.create(jobData({ title: `Visible ${i}`, reviewStatus: "published" })));
    }
    const hidden = await Job.create(jobData({ title: "Hidden", reviewStatus: "pending_review" }));

    // hidden job was saved while public, then pulled back to review
    for (const job of [visible[0], hidden, visible[1], visible[2]]) {
      await SavedJob.create({ user: user._id, job: job._id });
    }

    const page1 = await request(app).get("/api/jobs/saved?limit=2&page=1").set(auth(token));
    const page2 = await request(app).get("/api/jobs/saved?limit=2&page=2").set(auth(token));

    expect(page1.status).toBe(200);
    expect(page1.body.pagination.total).toBe(3);
    expect(page1.body.pagination.totalPages).toBe(2);
    expect(page1.body.jobs).toHaveLength(2);
    expect(page2.body.jobs).toHaveLength(1);

    const titles = [...page1.body.jobs, ...page2.body.jobs].map((job) => job.title);
    expect(titles).not.toContain("Hidden");
    expect(new Set(titles).size).toBe(3);
  });
});

describe("ingestion config", () => {
  it("a set-but-invalid spending cap fails closed to 0, an unset one uses the default", () => {
    const keep = process.env.INGESTION_DAILY_LLM_CAP;
    try {
      delete process.env.INGESTION_DAILY_LLM_CAP;
      expect(getConfig().dailyLlmCap).toBe(300);
      process.env.INGESTION_DAILY_LLM_CAP = "-5";
      expect(getConfig().dailyLlmCap).toBe(0);
      process.env.INGESTION_DAILY_LLM_CAP = "lots";
      expect(getConfig().dailyLlmCap).toBe(0);
      process.env.INGESTION_DAILY_LLM_CAP = "50";
      expect(getConfig().dailyLlmCap).toBe(50);
    } finally {
      if (keep === undefined) delete process.env.INGESTION_DAILY_LLM_CAP;
      else process.env.INGESTION_DAILY_LLM_CAP = keep;
    }
  });
});
