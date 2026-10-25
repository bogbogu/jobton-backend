import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";

const { default: app } = await import("../app.js");
const { default: User } = await import("../src/models/user.model.js");
const { default: Job } = await import("../src/models/job.model.js");
const { default: generateToken } = await import("../src/utils/generateToken.js");

let mongoServer;
let emailCounter = 0;

const createUserWithToken = async ({ role = "user" } = {}) => {
  emailCounter += 1;
  const user = await User.create({
    firstName: "Test",
    lastName: "User",
    email: `sections-${emailCounter}@example.com`,
    password: "not-a-real-password",
    isVerified: true,
    role,
  });

  return { user, token: generateToken(user._id) };
};

const auth = (token) => ({ Authorization: `Bearer ${token}` });

const jobData = (overrides = {}) => ({
  title: "Senior Product Designer",
  company: "Acme Payments",
  location: "Lagos, Nigeria",
  employmentType: "Full Time",
  salaryMin: 800000,
  category: "Design",
  description: "We are looking for a talented designer.",
  applicationLink: "https://acme.com/careers/123",
  ...overrides,
});

const items = (count, prefix = "Item") => Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`);

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

afterEach(async () => {
  await Job.deleteMany({});
  await User.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe("optional job sections (aboutCompany, requirements, benefits)", () => {
  it("default to an empty string / empty arrays on public jobs and the admin view", async () => {
    const { token } = await createUserWithToken({ role: "admin" });
    const job = await Job.create(jobData({ reviewStatus: "published" }));

    const publicResponse = await request(app).get(`/api/jobs/${job.id}`);
    expect(publicResponse.body.job).toMatchObject({ aboutCompany: "", requirements: [], benefits: [] });

    const adminResponse = await request(app).get(`/api/admin/jobs/${job.id}`).set(auth(token));
    expect(adminResponse.body.job).toMatchObject({ aboutCompany: "", requirements: [], benefits: [] });
  });

  it("also default for legacy documents stored without the fields", async () => {
    const { insertedId } = await Job.collection.insertOne({ ...jobData({ title: "Legacy" }), createdAt: new Date() });

    const response = await request(app).get(`/api/jobs/${insertedId}`);

    expect(response.status).toBe(200);
    expect(response.body.job).toMatchObject({ aboutCompany: "", requirements: [], benefits: [] });
  });

  it("can be set when posting a job, trimmed and stripped of HTML", async () => {
    const { token } = await createUserWithToken({ role: "admin" });

    const response = await request(app)
      .post("/api/jobs")
      .set(auth(token))
      .send(
        jobData({
          aboutCompany: "  <b>Acme</b> builds payment tools.<script>alert(1)</script>  ",
          requirements: ["  3 years of experience <i>required</i> ", "Bachelor's degree"],
          benefits: ["Health insurance", "<img src=x onerror=alert(1)>Pension"],
        })
      );

    expect(response.status).toBe(201);
    expect(response.body.job.aboutCompany).toBe("Acme builds payment tools.alert(1)");
    expect(response.body.job.requirements).toEqual(["3 years of experience required", "Bachelor's degree"]);
    expect(response.body.job.benefits).toEqual(["Health insurance", "Pension"]);
  });

  it("drop items that are blank once cleaned, before the count limit is applied", async () => {
    const { token } = await createUserWithToken({ role: "admin" });

    const response = await request(app)
      .post("/api/jobs")
      .set(auth(token))
      .send(
        jobData({
          requirements: ["  ", "", "<b></b>", "Real requirement", "<i> </i>"],
          benefits: [...items(20), "", "   ", "<br>"],
        })
      );

    expect(response.status).toBe(201);
    expect(response.body.job.requirements).toEqual(["Real requirement"]);
    expect(response.body.job.benefits).toEqual(items(20));
  });

  it("drop blank items on update too, and still reject non-strings", async () => {
    const { user, token } = await createUserWithToken();
    const job = await Job.create(jobData({ postedBy: user._id }));

    const blank = await request(app)
      .patch(`/api/jobs/${job.id}`)
      .set(auth(token))
      .send({ benefits: ["Pension", " ", ""] });
    expect(blank.status).toBe(200);
    expect(blank.body.job.benefits).toEqual(["Pension"]);

    const notStrings = await request(app)
      .patch(`/api/jobs/${job.id}`)
      .set(auth(token))
      .send({ benefits: [{ a: 1 }] });
    expect(notStrings.status).toBe(400);
  });

  it("are never required", async () => {
    const { token } = await createUserWithToken({ role: "admin" });

    const response = await request(app).post("/api/jobs").set(auth(token)).send(jobData());

    expect(response.status).toBe(201);
  });

  it("enforce the limits on create: 2000 chars, 20 items, 500 chars per item", async () => {
    const { token } = await createUserWithToken();

    const ok = await request(app)
      .post("/api/jobs")
      .set(auth(token))
      .send(
        jobData({
          aboutCompany: "a".repeat(2000),
          requirements: [...items(19), "r".repeat(500)],
          benefits: items(20),
        })
      );
    expect(ok.status).toBe(201);

    for (const overrides of [
      { aboutCompany: "a".repeat(2001) },
      { requirements: items(21) },
      { benefits: items(21) },
      { requirements: ["r".repeat(501)] },
      { benefits: ["b".repeat(501)] },
    ]) {
      const response = await request(app).post("/api/jobs").set(auth(token)).send(jobData(overrides));
      expect(response.status, JSON.stringify(Object.keys(overrides))).toBe(400);
    }
  });

  it("can be updated by the owner, which sends the job back to review", async () => {
    const { user, token } = await createUserWithToken();
    const job = await Job.create(jobData({ postedBy: user._id, reviewStatus: "published" }));

    const response = await request(app)
      .patch(`/api/jobs/${job.id}`)
      .set(auth(token))
      .send({ requirements: ["Two years of experience"], aboutCompany: "We are Acme." });

    expect(response.status).toBe(200);
    expect(response.body.job.requirements).toEqual(["Two years of experience"]);
    expect(response.body.job.aboutCompany).toBe("We are Acme.");
    expect((await Job.findById(job._id)).reviewStatus).toBe("pending_review");
  });

  it("are validated on update", async () => {
    const { user, token } = await createUserWithToken();
    const job = await Job.create(jobData({ postedBy: user._id }));

    const tooMany = await request(app).patch(`/api/jobs/${job.id}`).set(auth(token)).send({ benefits: items(21) });
    expect(tooMany.status).toBe(400);

    const notAList = await request(app).patch(`/api/jobs/${job.id}`).set(auth(token)).send({ requirements: { a: 1 } });
    expect(notAList.status).toBe(400);

    expect((await Job.findById(job._id)).benefits).toEqual([]);
  });

  describe("on approve", () => {
    const pendingIngestedJob = (overrides = {}) =>
      Job.create({
        title: "Backend Engineer",
        company: "Acme Payments",
        location: "Lagos, Nigeria",
        description: "Build APIs.",
        category: "Engineering",
        applyEmail: "jobs@acme.com",
        source: { kind: "telegram", channel: "ngjobsboard", messageId: 7 },
        ...overrides,
      });

    const approve = async (job, token, body = {}) =>
      request(app)
        .post(`/api/admin/jobs/${job.id}/approve`)
        .set(auth(token))
        .send({ expectedUpdatedAt: (await Job.findById(job._id)).updatedAt.toISOString(), ...body });

    it("are not needed to publish", async () => {
      const { token } = await createUserWithToken({ role: "admin" });
      const job = await pendingIngestedJob();

      const response = await approve(job, token);

      expect(response.status).toBe(200);
      expect(response.body.job).toMatchObject({ aboutCompany: "", requirements: [], benefits: [] });
    });

    it("can be edited by the admin and are saved cleaned", async () => {
      const { token } = await createUserWithToken({ role: "admin" });
      const job = await pendingIngestedJob({ requirements: ["Old requirement"] });

      const response = await approve(job, token, {
        edits: {
          aboutCompany: "  <b>Acme</b> is a payments company. ",
          requirements: ["  Degree in <u>Accounting</u> "],
          benefits: ["Pension", "HMO"],
        },
      });

      expect(response.status).toBe(200);
      expect(response.body.job.aboutCompany).toBe("Acme is a payments company.");
      expect(response.body.job.requirements).toEqual(["Degree in Accounting"]);
      expect(response.body.job.benefits).toEqual(["Pension", "HMO"]);

      const publicResponse = await request(app).get(`/api/jobs/${job.id}`);
      expect(publicResponse.body.job.benefits).toEqual(["Pension", "HMO"]);
    });

    it("keeps what the extractor stored when the admin does not edit them", async () => {
      const { token } = await createUserWithToken({ role: "admin" });
      const job = await pendingIngestedJob({ benefits: ["HMO"], aboutCompany: "Acme pays people." });

      const response = await approve(job, token, { edits: { category: "Software" } });

      expect(response.body.job).toMatchObject({ benefits: ["HMO"], aboutCompany: "Acme pays people." });
    });

    it("rejects values over the limits with VALIDATION_ERROR and publishes nothing", async () => {
      const { token } = await createUserWithToken({ role: "admin" });
      const job = await pendingIngestedJob();

      for (const edits of [
        { aboutCompany: "a".repeat(2001) },
        { requirements: items(21) },
        { benefits: ["b".repeat(501)] },
      ]) {
        const response = await approve(job, token, { edits });
        expect(response.status).toBe(400);
        expect(response.body.error).toBe("VALIDATION_ERROR");
      }
      expect((await Job.findById(job._id)).reviewStatus).toBe("pending_review");
    });
  });
});
