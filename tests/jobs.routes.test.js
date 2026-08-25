import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";

const { default: app } = await import("../app.js");
const { default: User } = await import("../src/models/user.model.js");
const { default: Job } = await import("../src/models/job.model.js");
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

const validJobPayload = (overrides = {}) => ({
  title: "Senior Product Designer",
  company: "Flutterwave",
  domain: "flutterwave.com",
  location: "Lagos, Nigeria (Remote)",
  employmentType: "Full Time",
  salaryMin: 800000,
  salaryCurrency: "NGN",
  salaryPeriod: "month",
  category: "Design",
  industry: "Fintech",
  skills: ["UI/UX", "Figma"],
  description: "We are looking for a talented designer.",
  applicationLink: "https://flutterwave.com/careers/123",
  ...overrides,
});

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();
  await mongoose.connect(uri);
});

afterEach(async () => {
  await Job.deleteMany({});
  await User.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe("Job routes", () => {
  it("GET /api/jobs returns an empty list with pagination metadata when there are no jobs", async () => {
    const response = await request(app).get("/api/jobs");

    expect(response.status).toBe(200);
    expect(response.body.jobs).toEqual([]);
    expect(response.body.pagination).toEqual({ page: 1, limit: 12, total: 0, totalPages: 0 });
  });

  it("POST /api/jobs requires authentication", async () => {
    const response = await request(app).post("/api/jobs").send(validJobPayload());

    expect(response.status).toBe(401);
  });

  it("POST /api/jobs creates a job and returns the frontend-shaped payload", async () => {
    const { token, user } = await createUserWithToken();

    const response = await request(app)
      .post("/api/jobs")
      .set("Authorization", `Bearer ${token}`)
      .send(validJobPayload());

    expect(response.status).toBe(201);
    expect(response.body.job).toMatchObject({
      title: "Senior Product Designer",
      company: "Flutterwave",
      type: "Full Time",
      salary: "₦800,000 / month",
      category: "Design",
      applicants: 0,
      postedBy: user._id.toString(),
    });
    expect(typeof response.body.job.id).toBe("string");
    expect(response.body.job.posted).toBe("Today");
  });

  it("POST /api/jobs rejects a payload missing required fields", async () => {
    const { token } = await createUserWithToken();

    const response = await request(app)
      .post("/api/jobs")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Incomplete Job" });

    expect(response.status).toBe(400);
  });

  it("formats a salary range with a min and max", async () => {
    const { token } = await createUserWithToken();

    const response = await request(app)
      .post("/api/jobs")
      .set("Authorization", `Bearer ${token}`)
      .send(validJobPayload({ salaryMin: 2000, salaryMax: 2500, salaryCurrency: "USD" }));

    expect(response.body.job.salary).toBe("$2,000 – $2,500 / month");
  });

  it("stores and returns workArrangement separately from employmentType", async () => {
    const { token } = await createUserWithToken();

    const response = await request(app)
      .post("/api/jobs")
      .set("Authorization", `Bearer ${token}`)
      .send(validJobPayload({ employmentType: "Full Time", workArrangement: "Hybrid" }));

    expect(response.body.job.type).toBe("Full Time");
    expect(response.body.job.workArrangement).toBe("Hybrid");
  });

  it("filters by `type` against either employmentType or workArrangement", async () => {
    const { token } = await createUserWithToken();

    // Full Time + Hybrid — matching the frontend's "Hybrid" filter option
    // even though that's a work arrangement, not an employment type.
    await Job.create({ ...validJobPayload({ title: "Hybrid Role" }), employmentType: "Full Time", workArrangement: "Hybrid" });
    await Job.create({ ...validJobPayload({ title: "Fully Remote Role" }), employmentType: "Full Time", workArrangement: "Remote" });

    const response = await request(app).get("/api/jobs").query({ type: "Hybrid" });

    expect(response.body.jobs).toHaveLength(1);
    expect(response.body.jobs[0].title).toBe("Hybrid Role");
  });

  it("combines keyword and type filters correctly (regression: $or key collision)", async () => {
    const { token } = await createUserWithToken();
    void token;

    await Job.create({ ...validJobPayload({ title: "Remote Backend Engineer" }), employmentType: "Contract", workArrangement: "Remote" });
    await Job.create({ ...validJobPayload({ title: "Remote Product Designer" }), employmentType: "Full Time", workArrangement: "Remote" });

    const response = await request(app).get("/api/jobs").query({ keyword: "Backend", type: "Remote" });

    expect(response.body.jobs).toHaveLength(1);
    expect(response.body.jobs[0].title).toBe("Remote Backend Engineer");
  });

  it("filters jobs by keyword, type, industry, and category", async () => {
    const { token } = await createUserWithToken();

    await request(app).post("/api/jobs").set("Authorization", `Bearer ${token}`).send(
      validJobPayload({ title: "Backend Engineer", category: "Engineering", industry: "Fintech", employmentType: "Contract" })
    );
    await request(app).post("/api/jobs").set("Authorization", `Bearer ${token}`).send(
      validJobPayload({ title: "Product Designer", category: "Design", industry: "Technology", employmentType: "Full Time" })
    );

    const byKeyword = await request(app).get("/api/jobs").query({ keyword: "Backend" });
    expect(byKeyword.body.jobs).toHaveLength(1);
    expect(byKeyword.body.jobs[0].title).toBe("Backend Engineer");

    const byCategory = await request(app).get("/api/jobs").query({ category: "Design" });
    expect(byCategory.body.jobs).toHaveLength(1);
    expect(byCategory.body.jobs[0].category).toBe("Design");

    const byType = await request(app).get("/api/jobs").query({ type: "Contract" });
    expect(byType.body.jobs).toHaveLength(1);
    expect(byType.body.jobs[0].type).toBe("Contract");
  });

  it("sorts jobs by most applicants", async () => {
    const { token } = await createUserWithToken();
    const created1 = await Job.create({ ...validJobPayload({ title: "Low Applicants" }) });
    const created2 = await Job.create({ ...validJobPayload({ title: "High Applicants" }) });
    created2.applicants = 50;
    await created2.save();
    void token;
    void created1;

    const response = await request(app).get("/api/jobs").query({ sort: "MOST_APPLICANTS" });

    expect(response.body.jobs[0].title).toBe("High Applicants");
  });

  it("GET /api/jobs/:id returns 404 for a missing or invalid id", async () => {
    const missing = await request(app).get(`/api/jobs/${new mongoose.Types.ObjectId()}`);
    expect(missing.status).toBe(404);

    const invalid = await request(app).get("/api/jobs/not-a-valid-id");
    expect(invalid.status).toBe(404);
  });

  it("only the owner or an admin can update or delete a job", async () => {
    const { token: ownerToken, user: owner } = await createUserWithToken({ email: "owner@example.com" });
    const { token: strangerToken } = await createUserWithToken({ email: "stranger@example.com" });
    const { token: adminToken } = await createUserWithToken({ email: "admin@example.com", role: "admin" });

    const job = await Job.create({ ...validJobPayload(), postedBy: owner._id });

    const strangerAttempt = await request(app)
      .patch(`/api/jobs/${job._id}`)
      .set("Authorization", `Bearer ${strangerToken}`)
      .send({ title: "Hijacked title" });
    expect(strangerAttempt.status).toBe(403);

    const ownerAttempt = await request(app)
      .patch(`/api/jobs/${job._id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ title: "Updated by owner" });
    expect(ownerAttempt.status).toBe(200);
    expect(ownerAttempt.body.job.title).toBe("Updated by owner");

    const adminDelete = await request(app)
      .delete(`/api/jobs/${job._id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(adminDelete.status).toBe(200);

    const afterDelete = await Job.findById(job._id);
    expect(afterDelete).toBeNull();
  });
});
