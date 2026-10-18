import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const { default: app } = await import("../app.js");
const { default: User } = await import("../src/models/user.model.js");
const { default: Job } = await import("../src/models/job.model.js");
const { default: SavedJob } = await import("../src/models/savedJob.model.js");
const { default: generateToken } = await import("../src/utils/generateToken.js");

let mongoServer;

const createUserWithToken = async ({ role = "user", email = "user@example.com" } = {}) => {
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

const jobData = (overrides = {}) => ({
  title: "Product Designer",
  company: "Acme",
  location: "Lagos, Nigeria",
  employmentType: "Full Time",
  salaryMin: 500000,
  category: "Design",
  description: "Design things.",
  applicationLink: "https://example.com/apply",
  ...overrides,
});

// Mongoose fails closed to pending_review on new docs, so be explicit.
const createJob = (reviewStatus, overrides = {}) =>
  Job.create(jobData({ reviewStatus, ...overrides }));

// A pre-review-workflow document: no reviewStatus field at all.
const insertLegacyJob = async (overrides = {}) => {
  const now = new Date();
  const { insertedId } = await Job.collection.insertOne({
    ...jobData(overrides),
    status: [],
    skills: [],
    responsibilities: [],
    applicants: 0,
    postedBy: null,
    createdAt: now,
    updatedAt: now,
  });
  return insertedId;
};

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

afterEach(async () => {
  await Job.deleteMany({});
  await User.deleteMany({});
  await SavedJob.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe("Job visibility (review workflow)", () => {
  it("fails closed: a new job with no reviewStatus is pending_review", async () => {
    const job = await Job.create(jobData());
    expect(job.reviewStatus).toBe("pending_review");
  });

  it("hides pending and rejected jobs from GET /api/jobs, including the total", async () => {
    await createJob("published", { title: "Live" });
    await createJob("pending_review", { title: "Pending" });
    await createJob("rejected", { title: "Rejected" });

    const response = await request(app).get("/api/jobs");

    expect(response.status).toBe(200);
    expect(response.body.jobs.map((j) => j.title)).toEqual(["Live"]);
    expect(response.body.pagination.total).toBe(1);
  });

  it("returns 404 (same body as not found) for hidden jobs on GET /api/jobs/:id", async () => {
    const pending = await createJob("pending_review");
    const rejected = await createJob("rejected");
    const missing = await request(app).get(`/api/jobs/${new mongoose.Types.ObjectId()}`);

    for (const job of [pending, rejected]) {
      const response = await request(app).get(`/api/jobs/${job._id}`);
      expect(response.status).toBe(404);
      expect(response.body).toEqual(missing.body);
    }
  });

  it("keeps a hidden job hidden on the public detail endpoint even from its owner", async () => {
    const { token, user } = await createUserWithToken();
    const job = await createJob("pending_review", { postedBy: user._id });

    const response = await request(app).get(`/api/jobs/${job._id}`).set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(404);
  });

  it("excludes hidden jobs from /api/categories counts", async () => {
    await createJob("published", { category: "Design" });
    await createJob("pending_review", { category: "Design" });
    await createJob("rejected", { category: "Hidden Only" });

    const response = await request(app).get("/api/categories");

    expect(response.body.categories).toEqual([{ title: "Design", jobCount: 1 }]);
  });

  it("excludes hidden jobs from ?company= results", async () => {
    await createJob("published", { title: "Live", company: "Acme" });
    await createJob("pending_review", { title: "Pending", company: "Acme" });
    await createJob("rejected", { title: "Rejected", company: "Acme" });

    const response = await request(app).get("/api/jobs").query({ company: "Acme" });

    expect(response.body.jobs.map((j) => j.title)).toEqual(["Live"]);
    expect(response.body.pagination.total).toBe(1);
  });

  it("skips jobs that became hidden after being saved on GET /api/jobs/saved", async () => {
    const { token, user } = await createUserWithToken();
    const live = await createJob("published", { title: "Live" });
    const hidden = await createJob("published", { title: "Later hidden" });
    await SavedJob.create([
      { user: user._id, job: live._id },
      { user: user._id, job: hidden._id },
    ]);

    await Job.updateOne({ _id: hidden._id }, { reviewStatus: "rejected" });

    const response = await request(app).get("/api/jobs/saved").set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.jobs.map((j) => j.title)).toEqual(["Live"]);
  });

  it("returns 404 when saving a hidden job, but still lets the user unsave it", async () => {
    const { token, user } = await createUserWithToken();
    const pending = await createJob("pending_review");
    const rejected = await createJob("rejected");
    const wasPublished = await createJob("rejected");
    await SavedJob.create({ user: user._id, job: wasPublished._id });

    for (const job of [pending, rejected]) {
      const response = await request(app).post(`/api/jobs/${job._id}/save`).set("Authorization", `Bearer ${token}`);
      expect(response.status).toBe(404);
    }
    expect(await SavedJob.countDocuments({ user: user._id })).toBe(1);

    const unsave = await request(app)
      .delete(`/api/jobs/${wasPublished._id}/save`)
      .set("Authorization", `Bearer ${token}`);
    expect(unsave.status).toBe(200);
    expect(await SavedJob.countDocuments({ user: user._id })).toBe(0);
  });

  it("an admin cannot save a hidden job either", async () => {
    const { token } = await createUserWithToken({ role: "admin", email: "admin@example.com" });
    const pending = await createJob("pending_review");

    const response = await request(app).post(`/api/jobs/${pending._id}/save`).set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(404);
  });

  it("legacy jobs with no reviewStatus stay public everywhere", async () => {
    const id = await insertLegacyJob({ title: "Legacy", company: "Oldco", category: "Legacy Cat" });
    const { token, user } = await createUserWithToken();

    // Sanity: the stored document really has no reviewStatus.
    const raw = await Job.collection.findOne({ _id: id });
    expect(raw).not.toHaveProperty("reviewStatus");

    const list = await request(app).get("/api/jobs");
    expect(list.body.jobs.map((j) => j.title)).toEqual(["Legacy"]);
    expect(list.body.pagination.total).toBe(1);

    const byCompany = await request(app).get("/api/jobs").query({ company: "Oldco" });
    expect(byCompany.body.jobs).toHaveLength(1);

    const detail = await request(app).get(`/api/jobs/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.job.title).toBe("Legacy");

    const categories = await request(app).get("/api/categories");
    expect(categories.body.categories).toEqual([{ title: "Legacy Cat", jobCount: 1 }]);

    const save = await request(app).post(`/api/jobs/${id}/save`).set("Authorization", `Bearer ${token}`);
    expect(save.status).toBe(200);
    expect(await SavedJob.countDocuments({ user: user._id })).toBe(1);

    const saved = await request(app).get("/api/jobs/saved").set("Authorization", `Bearer ${token}`);
    expect(saved.body.jobs.map((j) => j.title)).toEqual(["Legacy"]);
  });

  it("never exposes review or ingestion internals on public endpoints", async () => {
    await createJob("published", {
      title: "Ingested",
      applyEmail: "jobs@acme.com",
      applyPhone: "+2348012345678",
      source: { kind: "telegram", channel: "somechannel", messageId: 42, url: "https://t.me/somechannel/42", postedAt: new Date() },
      extraction: { model: "m", redFlags: ["x"], linkClass: "other_domain" },
      review: { rejectionReason: "private note" },
      dedupeKey: "abc123",
    });

    const list = await request(app).get("/api/jobs");
    const job = list.body.jobs[0];

    expect(job).toMatchObject({
      applyEmail: "jobs@acme.com",
      applyPhone: "+2348012345678",
      source: { kind: "telegram", channel: "somechannel", url: "https://t.me/somechannel/42" },
    });
    for (const key of ["reviewStatus", "review", "extraction", "dedupeKey"]) {
      expect(job).not.toHaveProperty(key);
    }
    expect(Object.keys(job.source).sort()).toEqual(["channel", "kind", "url"]);

    const detail = await request(app).get(`/api/jobs/${job.id}`);
    expect(JSON.stringify(detail.body)).not.toMatch(/reviewStatus|rejectionReason|dedupeKey|messageId|postedAt|redFlags/);
  });

  it("serializes jobs without company/type/source safely", async () => {
    await Job.collection.insertOne({
      title: "Bare",
      description: "Bare bones",
      reviewStatus: "published",
      status: [],
      skills: [],
      responsibilities: [],
      applicants: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const response = await request(app).get("/api/jobs");

    expect(response.status).toBe(200);
    expect(response.body.jobs[0]).toMatchObject({
      company: null,
      companySlug: null,
      type: null,
      applyEmail: null,
      applyPhone: null,
      source: null,
      salary: "Not specified",
    });
  });
});
