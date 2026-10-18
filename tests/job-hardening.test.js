import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const { default: app } = await import("../app.js");
const { default: User } = await import("../src/models/user.model.js");
const { default: Job } = await import("../src/models/job.model.js");
const { default: Company } = await import("../src/models/company.model.js");
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

const validJobPayload = (overrides = {}) => ({
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

const auth = (token) => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

afterEach(async () => {
  await Job.deleteMany({});
  await User.deleteMany({});
  await Company.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe("createJob hardening", () => {
  it("creates a pending job for a non-admin and ignores protected/forged body fields", async () => {
    const { token, user } = await createUserWithToken();

    const response = await request(app)
      .post("/api/jobs")
      .set(auth(token))
      .send(
        validJobPayload({
          reviewStatus: "published",
          review: { rejectionReason: "x" },
          source: { kind: "telegram", channel: "evil", messageId: 1, url: "https://evil.example.com" },
          extraction: { model: "fake", redFlags: [] },
          dedupeKey: "forged",
          status: ["verified"],
          applyEmail: "x@y.com",
          applyPhone: "+2348000000000",
          postedBy: new mongoose.Types.ObjectId().toString(),
        })
      );

    expect(response.status).toBe(201);
    expect(response.body.message).toBe("Job submitted for review.");
    expect(response.body.job).toMatchObject({ status: [], applyEmail: null, applyPhone: null, source: null });

    const stored = await Job.findById(response.body.job.id).lean();
    expect(stored.reviewStatus).toBe("pending_review");
    expect(stored.postedBy.toString()).toBe(user._id.toString());
    expect(stored.status).toEqual([]);
    expect(stored.applyEmail).toBeUndefined();
    expect(stored.applyPhone).toBeUndefined();
    expect(stored.dedupeKey).toBeUndefined();
    expect(stored.source?.kind).toBeUndefined();
    expect(stored.source?.channel).toBeUndefined();
    expect(stored.extraction?.model).toBeUndefined();
    expect(stored.review?.rejectionReason).toBeUndefined();

    const list = await request(app).get("/api/jobs");
    expect(list.body.jobs).toEqual([]);
  });

  it("creates a published job for an admin, who may also set status badges", async () => {
    const { token } = await createUserWithToken({ role: "admin", email: "admin@example.com" });

    const response = await request(app)
      .post("/api/jobs")
      .set(auth(token))
      .send(validJobPayload({ status: ["verified", "featured"], reviewStatus: "rejected", applyEmail: "x@y.com" }));

    expect(response.status).toBe(201);
    expect(response.body.message).toBe("Job created successfully.");
    expect(response.body.job.status).toEqual(["verified", "featured"]);
    expect(response.body.job.applyEmail).toBeNull();

    const stored = await Job.findById(response.body.job.id).lean();
    expect(stored.reviewStatus).toBe("published");

    const list = await request(app).get("/api/jobs");
    expect(list.body.jobs).toHaveLength(1);
  });

  it("accepts salaryMin of 0", async () => {
    const { token } = await createUserWithToken();

    const response = await request(app).post("/api/jobs").set(auth(token)).send(validJobPayload({ salaryMin: 0 }));

    expect(response.status).toBe(201);
    expect(response.body.job.salary).toBe("₦0 / month");
  });

  it("still rejects a missing salaryMin", async () => {
    const { token } = await createUserWithToken();
    const payload = validJobPayload();
    delete payload.salaryMin;

    const response = await request(app).post("/api/jobs").set(auth(token)).send(payload);

    expect(response.status).toBe(400);
  });
});

describe("updateJob hardening", () => {
  it("lets the owner PATCH their own pending job, while a stranger gets 404", async () => {
    const { token: ownerToken, user: owner } = await createUserWithToken({ email: "owner@example.com" });
    const { token: strangerToken } = await createUserWithToken({ email: "stranger@example.com" });
    const job = await Job.create(validJobPayload({ reviewStatus: "pending_review", postedBy: owner._id }));

    const stranger = await request(app)
      .patch(`/api/jobs/${job._id}`)
      .set(auth(strangerToken))
      .send({ title: "Hijacked" });
    expect(stranger.status).toBe(404);

    const ownerPatch = await request(app).patch(`/api/jobs/${job._id}`).set(auth(ownerToken)).send({ title: "Mine" });
    expect(ownerPatch.status).toBe(200);
    expect(ownerPatch.body.job.title).toBe("Mine");
    expect((await Job.findById(job._id)).reviewStatus).toBe("pending_review");

    const ownerDelete = await request(app).delete(`/api/jobs/${job._id}`).set(auth(ownerToken));
    expect(ownerDelete.status).toBe(200);
  });

  it("a stranger also gets 404 deleting someone else's pending job", async () => {
    const { user: owner } = await createUserWithToken({ email: "owner@example.com" });
    const { token: strangerToken } = await createUserWithToken({ email: "stranger@example.com" });
    const job = await Job.create(validJobPayload({ reviewStatus: "pending_review", postedBy: owner._id }));

    const response = await request(app).delete(`/api/jobs/${job._id}`).set(auth(strangerToken));

    expect(response.status).toBe(404);
    expect(await Job.findById(job._id)).not.toBeNull();
  });

  it("sends a published job back to pending when its owner edits it", async () => {
    const { token, user } = await createUserWithToken();
    const job = await Job.create(validJobPayload({ reviewStatus: "published", postedBy: user._id }));

    const before = await request(app).get("/api/jobs");
    expect(before.body.jobs).toHaveLength(1);

    const response = await request(app)
      .patch(`/api/jobs/${job._id}`)
      .set(auth(token))
      .send({ applicationLink: "https://example.com/new-link" });
    expect(response.status).toBe(200);

    expect((await Job.findById(job._id)).reviewStatus).toBe("pending_review");

    const after = await request(app).get("/api/jobs");
    expect(after.body.jobs).toEqual([]);
    expect((await request(app).get(`/api/jobs/${job._id}`)).status).toBe(404);
  });

  it("sends a legacy job (no reviewStatus) back to pending when its owner edits it", async () => {
    const { token, user } = await createUserWithToken();
    const now = new Date();
    const { insertedId } = await Job.collection.insertOne({
      ...validJobPayload(),
      status: [],
      skills: [],
      responsibilities: [],
      applicants: 0,
      postedBy: user._id,
      createdAt: now,
      updatedAt: now,
    });

    const response = await request(app).patch(`/api/jobs/${insertedId}`).set(auth(token)).send({ title: "Edited" });

    expect(response.status).toBe(200);
    expect((await Job.findById(insertedId)).reviewStatus).toBe("pending_review");
  });

  it("keeps a job published when an admin edits it", async () => {
    const { token: adminToken } = await createUserWithToken({ role: "admin", email: "admin@example.com" });
    const { user: owner } = await createUserWithToken({ email: "owner@example.com" });
    const job = await Job.create(validJobPayload({ reviewStatus: "published", postedBy: owner._id }));

    const response = await request(app)
      .patch(`/api/jobs/${job._id}`)
      .set(auth(adminToken))
      .send({ title: "Admin edit", status: ["verified"] });

    expect(response.status).toBe(200);
    expect(response.body.job.status).toEqual(["verified"]);
    expect((await Job.findById(job._id)).reviewStatus).toBe("published");
    expect((await request(app).get("/api/jobs")).body.jobs).toHaveLength(1);
  });

  it("ignores protected fields and status badges in an owner PATCH", async () => {
    const { token, user } = await createUserWithToken();
    const other = new mongoose.Types.ObjectId();
    const job = await Job.create(validJobPayload({ reviewStatus: "pending_review", postedBy: user._id }));

    const response = await request(app)
      .patch(`/api/jobs/${job._id}`)
      .set(auth(token))
      .send({
        reviewStatus: "published",
        review: { rejectionReason: "x" },
        source: { kind: "telegram", channel: "evil" },
        extraction: { model: "fake" },
        dedupeKey: "forged",
        applyEmail: "x@y.com",
        applyPhone: "+2348000000000",
        postedBy: other.toString(),
        status: ["verified"],
        title: "Legit edit",
      });

    expect(response.status).toBe(200);

    const stored = await Job.findById(job._id).lean();
    expect(stored.title).toBe("Legit edit");
    expect(stored.reviewStatus).toBe("pending_review");
    expect(stored.postedBy.toString()).toBe(user._id.toString());
    expect(stored.status).toEqual([]);
    expect(stored.applyEmail).toBeUndefined();
    expect(stored.applyPhone).toBeUndefined();
    expect(stored.dedupeKey).toBeUndefined();
    expect(stored.source?.kind).toBeUndefined();
    expect(stored.extraction?.model).toBeUndefined();
    expect(stored.review?.rejectionReason).toBeUndefined();
  });
});

describe("applicationLink validation", () => {
  const badLinks = [
    "javascript:alert(1)",
    "data:text/html,x",
    "//evil.com",
    "https://user:pw@a.com",
    "https://127.0.0.1/x",
    `https://example.com/${"a".repeat(3000)}`,
  ];

  it.each(badLinks)("rejects %s on POST", async (applicationLink) => {
    const { token } = await createUserWithToken();

    const response = await request(app).post("/api/jobs").set(auth(token)).send(validJobPayload({ applicationLink }));

    expect(response.status).toBe(400);
    expect(await Job.countDocuments()).toBe(0);
  });

  it.each(badLinks)("rejects %s on PATCH", async (applicationLink) => {
    const { token, user } = await createUserWithToken();
    const job = await Job.create(validJobPayload({ reviewStatus: "pending_review", postedBy: user._id }));

    const response = await request(app).patch(`/api/jobs/${job._id}`).set(auth(token)).send({ applicationLink });

    expect(response.status).toBe(400);
    expect((await Job.findById(job._id)).applicationLink).toBe("https://example.com/apply");
  });

  it("rejects an unsafe logoUrl and a non-hostname domain", async () => {
    const { token } = await createUserWithToken();

    const logo = await request(app)
      .post("/api/jobs")
      .set(auth(token))
      .send(validJobPayload({ logoUrl: "javascript:alert(1)" }));
    expect(logo.status).toBe(400);

    const domain = await request(app)
      .post("/api/jobs")
      .set(auth(token))
      .send(validJobPayload({ domain: "https://evil.com/path" }));
    expect(domain.status).toBe(400);
  });
});

describe("query-param hardening", () => {
  it("returns 200 for repeated or nested filter params instead of a CastError 500", async () => {
    await Job.create(validJobPayload({ reviewStatus: "published", industry: "a" }));

    const queries = [
      "industry=a&industry=b",
      "category=Design&category=Other",
      "company=Acme&company=Other",
      "type=Full%20Time&type=Contract",
      "keyword=a&keyword=b&location=x&location=y",
      "industry[$ne]=a",
      "sort=MOST_RECENT&sort=OLDEST",
      "sort=__proto__",
    ];

    for (const query of queries) {
      const response = await request(app).get(`/api/jobs?${query}`);
      expect(response.status, query).toBe(200);
    }
  });

  it("ignores array/object filter values instead of applying them", async () => {
    await Job.create(validJobPayload({ reviewStatus: "published", industry: "a" }));
    await Job.create(validJobPayload({ reviewStatus: "published", industry: "z" }));

    const response = await request(app).get("/api/jobs?industry=a&industry=b");

    expect(response.body.jobs).toHaveLength(2);
  });
});

describe("Company URL validation", () => {
  it("rejects unsafe website/logoUrl and a non-hostname domain", async () => {
    const { token } = await createUserWithToken();

    for (const body of [
      { name: "Evil One", website: "javascript:alert(1)" },
      { name: "Evil Two", logoUrl: "data:text/html,x" },
      { name: "Evil Three", domain: "https://evil.com" },
    ]) {
      const response = await request(app).post("/api/companies").set(auth(token)).send(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }

    expect(await Company.countDocuments()).toBe(0);
  });

  it("accepts valid or empty website/logoUrl/domain and rejects an unsafe PATCH", async () => {
    const { token } = await createUserWithToken({ role: "admin" });

    const created = await request(app)
      .post("/api/companies")
      .set(auth(token))
      .send({ name: "Good Co", website: "https://goodco.com", logoUrl: "", domain: "goodco.com" });
    expect(created.status).toBe(201);

    const bad = await request(app).patch("/api/companies/good-co").set(auth(token)).send({ website: "javascript:alert(1)" });
    expect(bad.status).toBe(400);
    expect((await Company.findOne({ slug: "good-co" })).website).toBe("https://goodco.com");
  });
});
