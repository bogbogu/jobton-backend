import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/email.service.js", () => ({
  validateEmailConfig: vi.fn(() => ({ isValid: true, missingVars: [], invalidVars: [] })),
  sendVerificationEmail: vi.fn(async () => ({ id: "mock-verification-email" })),
  sendResetPasswordEmail: vi.fn(async () => ({ id: "mock-reset-email" })),
}));

const { default: app } = await import("../app.js");
const { default: User } = await import("../src/models/user.model.js");
const { default: Job } = await import("../src/models/job.model.js");
const { default: generateToken } = await import("../src/utils/generateToken.js");
const { __resetAuthRateLimitStores } = await import("../src/middleware/authRateLimit.middleware.js");

let mongoServer;
let emailCounter = 0;

const createUserWithToken = async ({ role = "user" } = {}) => {
  emailCounter += 1;
  const user = await User.create({
    firstName: "Test",
    lastName: "User",
    email: `${role}-${emailCounter}@example.com`,
    password: "not-a-real-password",
    isVerified: true,
    role,
  });

  return { user, token: generateToken(user._id) };
};

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const unknownId = () => new mongoose.Types.ObjectId().toString();

const completeJobData = (overrides = {}) => ({
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

const ingestedJobData = (overrides = {}) => ({
  title: "Backend Engineer",
  company: "Acme Payments",
  location: "Lagos, Nigeria",
  description: "Build APIs for a fintech.",
  category: "Engineering",
  applyEmail: "jobs@acme.com",
  source: { kind: "telegram", channel: "ngjobsboard", messageId: 101 },
  ...overrides,
});

const versionOf = async (job) => (await Job.findById(job._id)).updatedAt.toISOString();

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

afterEach(async () => {
  vi.restoreAllMocks();
  __resetAuthRateLimitStores();
  await Job.deleteMany({});
  await User.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe("superadmin role", () => {
  it("is a valid role and unknown roles are not", async () => {
    await expect(createUserWithToken({ role: "superadmin" })).resolves.toBeTruthy();
    await expect(createUserWithToken({ role: "root" })).rejects.toThrow();
  });

  it("is returned as-is by /api/auth/me", async () => {
    const { token } = await createUserWithToken({ role: "superadmin" });

    const response = await request(app).get("/api/auth/me").set(auth(token));

    expect(response.status).toBe(200);
    expect(response.body.role).toBe("superadmin");
  });

  it("can use every admin route", async () => {
    const { token } = await createUserWithToken({ role: "superadmin" });

    for (const path of ["/api/admin/jobs", "/api/admin/telegram-channels"]) {
      const response = await request(app).get(path).set(auth(token));
      expect(response.status, path).toBe(200);
    }

    const job = await Job.create(ingestedJobData());
    const approve = await request(app)
      .post(`/api/admin/jobs/${job.id}/approve`)
      .set(auth(token))
      .send({ expectedUpdatedAt: await versionOf(job) });
    expect(approve.status).toBe(200);

    const other = await Job.create(ingestedJobData({ title: "Other" }));
    const reject = await request(app)
      .post(`/api/admin/jobs/${other.id}/reject`)
      .set(auth(token))
      .send({});
    expect(reject.status).toBe(200);
  });

  it("is treated like an admin on the owner-or-admin job, freelancer and company routes", async () => {
    const { token } = await createUserWithToken({ role: "superadmin" });
    const { user: owner } = await createUserWithToken();
    const job = await Job.create(completeJobData({ postedBy: owner._id, reviewStatus: "published" }));
    const hidden = await Job.create(completeJobData({ title: "Hidden", postedBy: owner._id, reviewStatus: "pending_review" }));

    const edit = await request(app)
      .patch(`/api/jobs/${job.id}`)
      .set(auth(token))
      .send({ description: "Edited by a superadmin." });
    expect(edit.status).toBe(200);
    // Like any admin edit, it does not send the job back to review.
    expect((await Job.findById(job._id)).reviewStatus).toBe("published");

    const seeHidden = await request(app).patch(`/api/jobs/${hidden.id}`).set(auth(token)).send({ industry: "Fintech" });
    expect(seeHidden.status).toBe(200);

    const created = await request(app)
      .post("/api/jobs")
      .set(auth(token))
      .send({ ...completeJobData({ title: "Posted by superadmin" }), status: ["verified"] });
    expect(created.status).toBe(201);
    expect(created.body.message).toBe("Job created successfully.");
    expect(created.body.job.status).toEqual(["verified"]);
  });

  it("is cut off the moment the role is removed in the database", async () => {
    const { user, token } = await createUserWithToken({ role: "superadmin" });
    await User.updateOne({ _id: user._id }, { role: "user" });

    expect((await request(app).get("/api/admin/jobs").set(auth(token))).status).toBe(403);
  });
});

describe("nobody can become admin or superadmin through the API", () => {
  it("register ignores a role in the body", async () => {
    for (const role of ["superadmin", "admin"]) {
      const response = await request(app)
        .post("/api/auth/register")
        .send({
          firstName: "Mallory",
          lastName: "Test",
          email: `mallory-${role}@example.com`,
          password: "Testing12345",
          role,
          isAdmin: true,
        });

      expect(response.status).toBe(201);
      expect(response.body.user.role).toBe("user");

      const stored = await User.findOne({ email: `mallory-${role}@example.com` });
      expect(stored.role).toBe("user");
    }
  });

  it("no auth route changes the role of an existing user", async () => {
    const { user, token } = await createUserWithToken();

    // There is no profile-update route; the only writes to a user are the auth
    // flows below, and none of them may take a role from the body.
    for (const [method, path] of [
      ["patch", "/api/auth/me"],
      ["put", "/api/auth/me"],
      ["post", "/api/auth/me"],
      ["patch", `/api/users/${user.id}`],
    ]) {
      const response = await request(app)[method](path).set(auth(token)).send({ role: "superadmin" });
      expect([404, 405]).toContain(response.status);
    }

    expect((await User.findById(user._id)).role).toBe("user");
  });
});

describe("POST /api/admin/jobs/:id/restore", () => {
  // expectedUpdatedAt is required: unless a test sends its own, send the job's current version.
  const restore = async (id, token, body = {}) => {
    let payload = body;
    if (!("expectedUpdatedAt" in body)) {
      const job = mongoose.Types.ObjectId.isValid(id) ? await Job.findById(id).catch(() => null) : null;
      payload = { ...body, expectedUpdatedAt: (job?.updatedAt ?? new Date()).toISOString() };
    }
    return request(app).post(`/api/admin/jobs/${id}/restore`).set(auth(token)).send(payload);
  };

  it("requires a login", async () => {
    const response = await request(app).post(`/api/admin/jobs/${unknownId()}/restore`).send({});
    expect(response.status).toBe(401);
  });

  it("returns 403 for a normal user and 403 FORBIDDEN_ROLE for a plain admin, before touching the job", async () => {
    const job = await Job.create(completeJobData({ reviewStatus: "rejected" }));

    const { token: userToken } = await createUserWithToken();
    expect((await restore(job.id, userToken)).status).toBe(403);

    const { token: adminToken } = await createUserWithToken({ role: "admin" });
    const response = await restore(job.id, adminToken);
    expect(response.status).toBe(403);
    expect(response.body.error).toBe("FORBIDDEN_ROLE");

    expect((await Job.findById(job._id)).reviewStatus).toBe("rejected");
  });

  it("returns 404 for an invalid or unknown id", async () => {
    const { token } = await createUserWithToken({ role: "superadmin" });

    expect((await restore("not-an-id", token)).status).toBe(404);
    expect((await restore(unknownId(), token)).status).toBe(404);
  });

  it("moves a rejected job back to pending_review and keeps its rejection data", async () => {
    const { user: admin, token: adminToken } = await createUserWithToken({ role: "admin" });
    const { user: superadmin, token } = await createUserWithToken({ role: "superadmin" });
    const job = await Job.create(ingestedJobData());

    const rejected = await request(app)
      .post(`/api/admin/jobs/${job.id}/reject`)
      .set(auth(adminToken))
      .send({ reason: "Looks like a scam." });
    expect(rejected.status).toBe(200);

    const response = await restore(job.id, token);

    expect(response.status).toBe(200);
    expect(response.body.message).toBe("Job restored to pending review.");
    expect(response.body.job.reviewStatus).toBe("pending_review");
    expect(response.body.job.review).toMatchObject({
      reviewedBy: admin.id,
      rejectionReason: "Looks like a scam.",
      restoredFromStatus: "rejected",
    });
    expect(response.body.job.review.reviewedAt).toBeTruthy();
    expect(response.body.job.review.restoredAt).toBeTruthy();
    // The restoring user's id is stored but not exposed.
    expect(JSON.stringify(response.body)).not.toContain(superadmin.id);

    const stored = await Job.findById(job._id).lean();
    expect(stored.reviewStatus).toBe("pending_review");
    expect(stored.review.restoredBy.toString()).toBe(superadmin.id);
    expect(stored.review.restoredFromStatus).toBe("rejected");
    expect(stored.review.rejectionReason).toBe("Looks like a scam.");
    expect(stored.review.reviewedBy.toString()).toBe(admin.id);
    expect(stored.dedupeKey).toBe(job.dedupeKey);

    const queue = await request(app).get("/api/admin/jobs").set(auth(token));
    expect(queue.body.jobs.map((entry) => entry.id)).toContain(job.id);
  });

  it("moves a published job back to review and hides it from the public", async () => {
    const { token } = await createUserWithToken({ role: "superadmin" });
    const job = await Job.create(completeJobData({ reviewStatus: "published" }));

    expect((await request(app).get(`/api/jobs/${job.id}`)).status).toBe(200);

    const response = await restore(job.id, token);

    expect(response.status).toBe(200);
    expect(response.body.job.reviewStatus).toBe("pending_review");
    expect(response.body.job.review.restoredFromStatus).toBe("published");
    expect((await request(app).get(`/api/jobs/${job.id}`)).status).toBe(404);
  });

  it("treats a legacy job without a reviewStatus as published", async () => {
    const { token } = await createUserWithToken({ role: "superadmin" });
    const { insertedId } = await Job.collection.insertOne({ ...completeJobData({ title: "Legacy" }), createdAt: new Date(), updatedAt: new Date() });

    const response = await restore(insertedId.toString(), token);

    expect(response.status).toBe(200);
    expect(response.body.job.review.restoredFromStatus).toBe("published");
    expect((await Job.findById(insertedId)).reviewStatus).toBe("pending_review");
  });

  it("answers 409 NOT_RESTORABLE for a job that is already pending", async () => {
    const { token } = await createUserWithToken({ role: "superadmin" });
    const job = await Job.create(ingestedJobData());

    const response = await restore(job.id, token);

    expect(response.status).toBe(409);
    expect(response.body.error).toBe("NOT_RESTORABLE");
    expect((await Job.findById(job._id)).review?.restoredAt).toBeUndefined();
  });

  it("can be approved again afterwards, with the new updatedAt", async () => {
    const { token } = await createUserWithToken({ role: "superadmin" });
    const job = await Job.create(completeJobData({ reviewStatus: "rejected" }));

    const restored = await restore(job.id, token);
    expect(restored.status).toBe(200);

    const stale = await request(app)
      .post(`/api/admin/jobs/${job.id}/approve`)
      .set(auth(token))
      .send({ expectedUpdatedAt: job.updatedAt.toISOString() });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe("STALE");

    const approved = await request(app)
      .post(`/api/admin/jobs/${job.id}/approve`)
      .set(auth(token))
      .send({ expectedUpdatedAt: restored.body.job.updatedAt });
    expect(approved.status).toBe(200);
    expect(approved.body.job.reviewStatus).toBe("published");
    expect(approved.body.job.review.restoredFromStatus).toBe("rejected");
  });

  it("rejecting a restored job without a reason does not show the old reason", async () => {
    const { token } = await createUserWithToken({ role: "superadmin" });
    const job = await Job.create(
      completeJobData({ reviewStatus: "rejected", review: { rejectionReason: "Old reason." } })
    );

    await restore(job.id, token);
    const again = await request(app).post(`/api/admin/jobs/${job.id}/reject`).set(auth(token)).send({});

    expect(again.status).toBe(200);
    expect(again.body.job.review.rejectionReason).toBeNull();
    expect(again.body.job.review.restoredFromStatus).toBe("rejected");
  });

  describe("expectedUpdatedAt", () => {
    it("restores when it matches the version that was read", async () => {
      const { token } = await createUserWithToken({ role: "superadmin" });
      const job = await Job.create(completeJobData({ reviewStatus: "rejected" }));

      const response = await restore(job.id, token, { expectedUpdatedAt: await versionOf(job) });

      expect(response.status).toBe(200);
    });

    it("answers 409 STALE when the job changed, and changes nothing", async () => {
      const { token } = await createUserWithToken({ role: "superadmin" });
      const job = await Job.create(completeJobData({ reviewStatus: "rejected" }));
      const seen = await versionOf(job);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await Job.updateOne({ _id: job._id }, { $set: { industry: "Fintech" } });

      const response = await restore(job.id, token, { expectedUpdatedAt: seen });

      expect(response.status).toBe(409);
      expect(response.body.error).toBe("STALE");
      expect((await Job.findById(job._id)).reviewStatus).toBe("rejected");
    });

    it("treats anything that is not a valid timestamp as stale", async () => {
      const { token } = await createUserWithToken({ role: "superadmin" });
      const job = await Job.create(completeJobData({ reviewStatus: "rejected" }));

      for (const expectedUpdatedAt of ["yesterday", {}, [], true, { toString: () => "2026-01-01" }]) {
        const response = await restore(job.id, token, { expectedUpdatedAt });
        expect(response.status).toBe(409);
        expect(response.body.error).toBe("STALE");
      }
      expect((await Job.findById(job._id)).reviewStatus).toBe("rejected");
    });

    it("is required: missing or null gives 400 EXPECTED_UPDATED_AT_REQUIRED and changes nothing", async () => {
      const { token } = await createUserWithToken({ role: "superadmin" });
      const job = await Job.create(completeJobData({ reviewStatus: "rejected" }));

      const send = (body) =>
        request(app).post(`/api/admin/jobs/${job.id}/restore`).set(auth(token)).send(body);

      for (const body of [{}, { expectedUpdatedAt: null }, { somethingElse: true }]) {
        const response = await send(body);
        expect(response.status).toBe(400);
        expect(response.body.error).toBe("EXPECTED_UPDATED_AT_REQUIRED");
      }
      const noBody = await request(app).post(`/api/admin/jobs/${job.id}/restore`).set(auth(token));
      expect(noBody.status).toBe(400);
      expect(noBody.body.error).toBe("EXPECTED_UPDATED_AT_REQUIRED");

      // Checked before the database is read, so even an unknown id answers 400.
      const unknown = await request(app).post(`/api/admin/jobs/${unknownId()}/restore`).set(auth(token)).send({});
      expect(unknown.status).toBe(400);

      expect((await Job.findById(job._id)).reviewStatus).toBe("rejected");
    });
  });

  it("is atomic: two simultaneous restores give one 200 and one 409", async () => {
    const { token } = await createUserWithToken({ role: "superadmin" });
    const job = await Job.create(completeJobData({ reviewStatus: "rejected" }));

    const results = await Promise.all([restore(job.id, token), restore(job.id, token)]);
    const statuses = results.map((response) => response.status).sort();

    expect(statuses).toEqual([200, 409]);
    const loser = results.find((response) => response.status === 409);
    expect(["NOT_RESTORABLE", "STALE"]).toContain(loser.body.error);
  });

  it("writes one audit line with ids only", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { user, token } = await createUserWithToken({ role: "superadmin" });
    const job = await Job.create(
      ingestedJobData({ applyEmail: "private-person@example.com", title: "Confidential Title" })
    );
    await Job.updateOne({ _id: job._id }, { $set: { reviewStatus: "rejected" } });

    await restore(job.id, token);

    const lines = info.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("action=restore"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`admin=${user.id}`);
    expect(lines[0]).toContain(`job=${job.id}`);
    expect(lines[0]).toContain("from=rejected");
    expect(lines[0]).not.toContain("private-person");
    expect(lines[0]).not.toContain("Confidential");
  });
});

describe("approve fills the company domain", () => {
  const approve = async (job, token, body = {}) =>
    request(app)
      .post(`/api/admin/jobs/${job.id}/approve`)
      .set(auth(token))
      .send({ expectedUpdatedAt: await versionOf(job), ...body });

  it("derives it from the apply link when the job has none", async () => {
    const { token } = await createUserWithToken({ role: "admin" });
    const job = await Job.create(ingestedJobData({ applicationLink: "https://Careers.Acme.com:8443/jobs/1" }));

    const response = await approve(job, token);

    expect(response.status).toBe(200);
    expect(response.body.job.domain).toBe("careers.acme.com");
  });

  it("falls back to the apply email domain", async () => {
    const { token } = await createUserWithToken({ role: "admin" });
    const job = await Job.create(ingestedJobData({ applyEmail: "hr@acme.com" }));

    expect((await approve(job, token)).body.job.domain).toBe("acme.com");
  });

  it("derives it from the merged values, so an edited apply link counts", async () => {
    const { token } = await createUserWithToken({ role: "admin" });
    const job = await Job.create(ingestedJobData({ applyEmail: undefined, applicationLink: "https://t.me/acme/12" }));

    // The company name vouches for the new link's host.
    const response = await approve(job, token, {
      edits: { applicationLink: "https://www.acme.io/apply", company: "Acme" },
    });

    expect(response.body.job.domain).toBe("acme.io");
  });

  it("uses a link whose host is the company's name, and ignores one that nothing vouches for", async () => {
    const { token } = await createUserWithToken({ role: "admin" });
    const vouched = await Job.create(
      ingestedJobData({ company: "Stripe", applyEmail: undefined, applicationLink: "https://stripe.com/jobs/1" })
    );
    const unvouched = await Job.create(
      ingestedJobData({
        title: "Other",
        company: "Acme Payments",
        applyEmail: "hr@other.org",
        applicationLink: "https://stripe.com/jobs/1",
      })
    );

    expect((await approve(vouched, token)).body.job.domain).toBe("stripe.com");
    expect((await approve(unvouched, token)).body.job.domain).toBe("");
  });

  it("leaves the domain empty for shared hosts and free mail", async () => {
    const { token } = await createUserWithToken({ role: "admin" });
    const shared = await Job.create(ingestedJobData({ applyEmail: "someone@gmail.com", applicationLink: "https://forms.gle/abc" }));

    const response = await approve(shared, token);

    expect(response.status).toBe(200);
    expect(response.body.job.domain).toBe("");
  });

  it("never overrides a domain the job already has", async () => {
    const { token } = await createUserWithToken({ role: "admin" });
    const job = await Job.create(
      ingestedJobData({ domain: "acme-group.com", applicationLink: "https://jobs.other.org/1" })
    );

    expect((await approve(job, token)).body.job.domain).toBe("acme-group.com");
  });

  it("never overrides a domain the admin typed", async () => {
    const { token } = await createUserWithToken({ role: "admin" });
    const job = await Job.create(ingestedJobData({ applicationLink: "https://jobs.other.org/1" }));

    const response = await approve(job, token, { edits: { domain: "acme-group.com" } });

    expect(response.body.job.domain).toBe("acme-group.com");
  });

  it("still validates a typed domain", async () => {
    const { token } = await createUserWithToken({ role: "admin" });
    const job = await Job.create(ingestedJobData({ applicationLink: "https://jobs.other.org/1" }));

    const response = await approve(job, token, { edits: { domain: "https://evil.example/x" } });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("VALIDATION_ERROR");
  });
});
