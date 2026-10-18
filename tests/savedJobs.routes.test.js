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

const createUserWithToken = async (email) => {
  const user = await User.create({
    firstName: "Test",
    lastName: "User",
    email,
    password: "$2a$10$eBv3z6r8E0FQn2mM1gM4QeSxwE5jQhTs6f6lJ7mUv7zNli3WfYB0m",
    isVerified: true,
  });

  return { user, token: generateToken(user._id) };
};

const createJob = (overrides = {}) =>
  Job.create({
    title: "Product Designer",
    company: "Flutterwave",
    location: "Lagos, Nigeria",
    employmentType: "Full Time",
    salaryMin: 500000,
    category: "Design",
    description: "Design things.",
    applicationLink: "https://example.com/apply",
    reviewStatus: "published",
    ...overrides,
  });

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

describe("Saved jobs", () => {
  it("requires authentication to save, unsave, or list saved jobs", async () => {
    const job = await createJob();

    expect((await request(app).post(`/api/jobs/${job._id}/save`)).status).toBe(401);
    expect((await request(app).delete(`/api/jobs/${job._id}/save`)).status).toBe(401);
    expect((await request(app).get("/api/jobs/saved")).status).toBe(401);
  });

  it("saves a job for the authenticated user and reflects it back on GET /api/jobs", async () => {
    const job = await createJob();
    const { token } = await createUserWithToken("saver@example.com");

    const saveResponse = await request(app)
      .post(`/api/jobs/${job._id}/save`)
      .set("Authorization", `Bearer ${token}`);
    expect(saveResponse.status).toBe(200);
    expect(saveResponse.body.saved).toBe(true);

    const listResponse = await request(app)
      .get("/api/jobs")
      .set("Authorization", `Bearer ${token}`);
    expect(listResponse.body.jobs.find((j) => j.id === job._id.toString()).saved).toBe(true);

    const detailResponse = await request(app)
      .get(`/api/jobs/${job._id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(detailResponse.body.job.saved).toBe(true);
  });

  it("does not mark a job as saved for a different user, or for an anonymous request", async () => {
    const job = await createJob();
    const { token: saverToken } = await createUserWithToken("saver@example.com");
    const { token: strangerToken } = await createUserWithToken("stranger@example.com");

    await request(app).post(`/api/jobs/${job._id}/save`).set("Authorization", `Bearer ${saverToken}`);

    const strangerView = await request(app).get(`/api/jobs/${job._id}`).set("Authorization", `Bearer ${strangerToken}`);
    expect(strangerView.body.job.saved).toBe(false);

    const anonymousView = await request(app).get(`/api/jobs/${job._id}`);
    expect(anonymousView.body.job.saved).toBe(false);
  });

  it("is idempotent — saving an already-saved job does not create duplicates", async () => {
    const job = await createJob();
    const { token, user } = await createUserWithToken("saver@example.com");

    await request(app).post(`/api/jobs/${job._id}/save`).set("Authorization", `Bearer ${token}`);
    await request(app).post(`/api/jobs/${job._id}/save`).set("Authorization", `Bearer ${token}`);

    expect(await SavedJob.countDocuments({ user: user._id, job: job._id })).toBe(1);
  });

  it("unsaves a job", async () => {
    const job = await createJob();
    const { token } = await createUserWithToken("saver@example.com");

    await request(app).post(`/api/jobs/${job._id}/save`).set("Authorization", `Bearer ${token}`);
    const unsaveResponse = await request(app)
      .delete(`/api/jobs/${job._id}/save`)
      .set("Authorization", `Bearer ${token}`);

    expect(unsaveResponse.status).toBe(200);
    expect(unsaveResponse.body.saved).toBe(false);

    const detail = await request(app).get(`/api/jobs/${job._id}`).set("Authorization", `Bearer ${token}`);
    expect(detail.body.job.saved).toBe(false);
  });

  it("GET /api/jobs/saved lists only the current user's saved jobs", async () => {
    const jobA = await createJob({ title: "Job A" });
    const jobB = await createJob({ title: "Job B" });
    const { token: userAToken } = await createUserWithToken("a@example.com");
    const { token: userBToken } = await createUserWithToken("b@example.com");

    await request(app).post(`/api/jobs/${jobA._id}/save`).set("Authorization", `Bearer ${userAToken}`);
    await request(app).post(`/api/jobs/${jobB._id}/save`).set("Authorization", `Bearer ${userBToken}`);

    const userASaved = await request(app).get("/api/jobs/saved").set("Authorization", `Bearer ${userAToken}`);
    expect(userASaved.body.jobs).toHaveLength(1);
    expect(userASaved.body.jobs[0].title).toBe("Job A");

    const userBSaved = await request(app).get("/api/jobs/saved").set("Authorization", `Bearer ${userBToken}`);
    expect(userBSaved.body.jobs).toHaveLength(1);
    expect(userBSaved.body.jobs[0].title).toBe("Job B");
  });
});
