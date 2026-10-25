import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/email.service.js", () => ({
  validateEmailConfig: vi.fn(() => ({ isValid: true, missingVars: [], invalidVars: [] })),
  sendVerificationEmail: vi.fn(async () => ({ id: "mock" })),
  sendResetPasswordEmail: vi.fn(async () => ({ id: "mock" })),
}));

const { default: app, startServer } = await import("../app.js");
const { default: User } = await import("../src/models/user.model.js");
const { default: Job } = await import("../src/models/job.model.js");
const { default: Freelancer } = await import("../src/models/freelancer.model.js");
const { default: Company } = await import("../src/models/company.model.js");
const { default: generateToken } = await import("../src/utils/generateToken.js");
const { toFieldErrors, validationErrorBody } = await import("../src/utils/errors.utils.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error.middleware.js");
const { __resetAuthRateLimitStores } = await import("../src/middleware/authRateLimit.middleware.js");
const { __resetResendThrottleStores } = await import(
  "../src/middleware/resendVerificationThrottle.middleware.js"
);

let mongoServer;

const PASSWORD_HASH = ["", "2a", "10", "a".repeat(53)].join("$");

const createUserWithToken = async ({ role = "user", email = "sec-user@example.com", extra = {} } = {}) => {
  const user = await User.create({
    firstName: "Sec",
    lastName: "User",
    email,
    password: PASSWORD_HASH,
    isVerified: true,
    role,
    ...extra,
  });

  return { user, token: generateToken(user._id) };
};

const validJobPayload = (overrides = {}) => ({
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

const validFreelancerPayload = (overrides = {}) => ({
  name: "Adaeze Okonkwo",
  role: "Frontend Developer",
  category: "Development",
  location: "Lagos, NG",
  hourlyRate: "$32/hr",
  yearsExperience: 5,
  bio: "Builds performant web interfaces.",
  email: "adaeze@jobton.dev",
  phone: "+2348103019001",
  ...overrides,
});

// Strings that must never appear in any client-facing error body.
const LEAK_MARKERS = [
  "Job validation",
  "User validation",
  "Freelancer validation",
  "Company validation",
  "is not a valid enum value",
  "Cast to",
  "ObjectId",
  "E11000",
  "dup key",
  "index:",
  "keyValue",
  "stack",
  "    at ",
  "mongoose",
  "MongoServerError",
  "node_modules",
];

const expectNoLeak = (body, extraSecrets = []) => {
  const text = JSON.stringify(body);
  for (const marker of [...LEAK_MARKERS, ...extraSecrets]) {
    expect(text.toLowerCase(), `response leaked "${marker}"`).not.toContain(marker.toLowerCase());
  }
};

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

afterEach(async () => {
  vi.restoreAllMocks();
  __resetAuthRateLimitStores();
  __resetResendThrottleStores();
  await Promise.all([
    Job.deleteMany({}),
    User.deleteMany({}),
    Freelancer.deleteMany({}),
    Company.deleteMany({}),
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe("response headers", () => {
  it("never sends X-Powered-By or a Server header", async () => {
    for (const path of ["/", "/api/jobs", "/api/categories", "/does-not-exist"]) {
      const response = await request(app).get(path);
      expect(response.headers["x-powered-by"], path).toBeUndefined();
      expect(response.headers.server, path).toBeUndefined();
    }
  });

  it("sends Cache-Control: no-store on auth, freelancer and admin responses", async () => {
    const { token } = await createUserWithToken();

    const responses = [
      await request(app).post("/api/auth/login").send({ email: "nobody@example.com", password: "x" }),
      await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`),
      await request(app).get("/api/auth/me"),
      await request(app).get("/api/freelancers"),
      await request(app).get("/api/freelancers").set("Authorization", `Bearer ${token}`),
      await request(app).get("/api/admin/jobs"),
      await request(app).get("/api/admin/jobs").set("Authorization", `Bearer ${token}`),
      await request(app).get("/api/jobs/saved").set("Authorization", `Bearer ${token}`),
    ];

    for (const response of responses) {
      expect(response.headers["cache-control"]).toBe("no-store");
    }
  });

  it("does not add no-store to the public job list", async () => {
    const response = await request(app).get("/api/jobs");
    expect(response.headers["cache-control"]).toBeUndefined();
  });
});

describe("404 and error handling", () => {
  it("answers unknown routes with a JSON 404 and no framework text", async () => {
    const response = await request(app).get("/definitely/not/here");

    expect(response.status).toBe(404);
    expect(response.headers["content-type"]).toMatch(/application\/json/);
    expect(response.body).toEqual({ message: "Not found.", error: "NOT_FOUND" });
    expect(response.text).not.toContain("Cannot GET");
  });

  it("answers unknown methods on a real path with the same JSON 404", async () => {
    const response = await request(app).delete("/api/categories");
    expect(response.status).toBe(404);
    expect(response.body.error).toBe("NOT_FOUND");
  });

  it("keeps GET / working as a JSON liveness check", async () => {
    const response = await request(app).get("/");
    expect(response.status).toBe(200);
    expect(response.body.message).toBe("API is running.");
  });

  it("returns 400 for malformed JSON without echoing the parser message or body", async () => {
    const response = await request(app)
      .post("/api/auth/login")
      .set("Content-Type", "application/json")
      .send('{"email": "a@b.com", "note": LEAKCHECK-ONE,}');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ message: "Invalid JSON.", error: "INVALID_JSON" });
    expect(response.text).not.toContain("LEAKCHECK-ONE");
    expect(response.text).not.toContain("Unexpected token");
  });

  it("does not write the rejected request body to the server log", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await request(app)
      .post("/api/auth/login")
      .set("Content-Type", "application/json")
      .send('{"note": LEAKCHECK-TWO,}');

    const logged = JSON.stringify([...error.mock.calls, ...warn.mock.calls]);
    expect(logged).not.toContain("LEAKCHECK-TWO");
  });

  it("returns 413 for a body over the 100kb limit", async () => {
    const response = await request(app)
      .post("/api/auth/login")
      .send({ email: "a@example.com", password: "x".repeat(150 * 1024) });

    expect(response.status).toBe(413);
    expect(response.body.error).toBe("PAYLOAD_TOO_LARGE");
    expectNoLeak(response.body);
  });

  it("returns 413 for an oversized urlencoded body", async () => {
    const response = await request(app)
      .post("/api/auth/login")
      .type("form")
      .send(`email=a%40example.com&password=${"x".repeat(150 * 1024)}`);

    expect(response.status).toBe(413);
  });

  it("returns 415 for an unsupported content encoding", async () => {
    const response = await request(app)
      .post("/api/auth/login")
      .set("Content-Type", "application/json")
      .set("Content-Encoding", "compress")
      .send("{}");

    expect(response.status).toBe(415);
    expect(response.body.error).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  it("returns a fixed 400 for a corrupt compressed body", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await request(app)
      .post("/api/auth/login")
      .set("Content-Type", "application/json")
      .set("Content-Encoding", "gzip")
      .send("this is not gzip data");

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ message: "Bad request.", error: "BAD_REQUEST" });
    expect(response.text).not.toMatch(/zlib|incorrect header|decompress/i);
  });

  it("returns 415 for an unsupported charset", async () => {
    const response = await request(app)
      .post("/api/auth/login")
      .set("Content-Type", "application/json; charset=iso-8859-1")
      .send("{}");

    expect(response.status).toBe(415);
  });

  describe("unexpected errors", () => {
    const buildApp = () => {
      const probe = express();
      probe.get("/boom", () => {
        const error = new Error(["connection to mongodb", "://svc:", "dbpass", "@db.internal:27017 refused"].join(""));
        error.stack = "Error: secret stack\n    at /srv/app/src/secret.js:1:1";
        throw error;
      });
      probe.get("/driver", (req, res, next) => {
        const error = new Error("E11000 duplicate key error collection: jobton.users index: email_1 dup key");
        error.name = "MongoServerError";
        error.code = 11000;
        error.keyValue = { email: "victim@example.com" };
        next(error);
      });
      probe.use(notFoundHandler);
      probe.use(errorHandler);
      return probe;
    };

    it.each(["production", "development", "test"])(
      "returns only a generic 500 when NODE_ENV=%s",
      async (nodeEnv) => {
        const previous = process.env.NODE_ENV;
        process.env.NODE_ENV = nodeEnv;
        vi.spyOn(console, "error").mockImplementation(() => {});

        try {
          for (const path of ["/boom", "/driver"]) {
            const response = await request(buildApp()).get(path);

            expect(response.status).toBe(500);
            expect(response.body).toEqual({ message: "Internal server error." });
            expect(response.text).not.toMatch(/dbpass|secret|mongodb|E11000|victim|index/i);
          }
        } finally {
          process.env.NODE_ENV = previous;
        }
      }
    );

    it("logs the error server-side", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});

      await request(buildApp()).get("/boom");

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toBeInstanceOf(Error);
    });
  });
});

describe("user serialization", () => {
  const SAFE_USER_KEYS = ["email", "firstName", "id", "isVerified", "lastName", "name", "role"];

  const sensitiveExtra = {
    emailVerificationToken: "hashed-verification-token",
    emailVerificationCode: "hashed-verification-code",
    emailVerificationExpiresAt: new Date(Date.now() + 60_000),
    passwordResetToken: "hashed-reset-token",
    passwordResetExpiresAt: new Date(Date.now() + 60_000),
    passwordResetUsedAt: new Date(),
  };

  it("GET /api/auth/me returns only the allow-listed fields", async () => {
    const { token, user } = await createUserWithToken({ extra: sensitiveExtra });

    const response = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(Object.keys(response.body).sort()).toEqual(SAFE_USER_KEYS);
    expect(response.body).toMatchObject({
      id: user._id.toString(),
      name: "Sec User",
      firstName: "Sec",
      lastName: "User",
      email: "sec-user@example.com",
      role: "user",
      isVerified: true,
    });
    expect(response.text).not.toMatch(/password|token|hashed-|__v|createdAt|updatedAt|_id/i);
  });

  it("login returns only the allow-listed user fields", async () => {
    const bcrypt = (await import("bcryptjs")).default;
    await User.create({
      firstName: "Log",
      lastName: "In",
      email: "login-shape@example.com",
      password: await bcrypt.hash("Strong123", 10),
      isVerified: true,
      ...sensitiveExtra,
    });

    const response = await request(app)
      .post("/api/auth/login")
      .send({ email: "login-shape@example.com", password: "Strong123" });

    expect(response.status).toBe(200);
    expect(typeof response.body.token).toBe("string");
    expect(Object.keys(response.body.user).sort()).toEqual(SAFE_USER_KEYS);
    expect(JSON.stringify(response.body.user)).not.toMatch(/password|hashed-|__v/i);
  });

  it("register returns only the allow-listed user fields", async () => {
    const response = await request(app).post("/api/auth/register").send({
      firstName: "New",
      lastName: "Person",
      email: "new-person@example.com",
      password: "Strong123",
    });

    expect(response.status).toBe(201);
    expect(Object.keys(response.body.user).sort()).toEqual(SAFE_USER_KEYS);
    expect(JSON.stringify(response.body)).not.toMatch(/verificationToken|verificationCode|password/i);
  });
});

describe("job serialization", () => {
  it("never exposes postedBy on public job endpoints", async () => {
    const { user, token } = await createUserWithToken();
    const admin = await createUserWithToken({ role: "admin", email: "sec-admin@example.com" });
    const job = await Job.create({
      ...validJobPayload(),
      reviewStatus: "published",
      postedBy: user._id,
    });

    const list = await request(app).get("/api/jobs");
    const detail = await request(app).get(`/api/jobs/${job._id}`);
    await request(app).post(`/api/jobs/${job._id}/save`).set("Authorization", `Bearer ${token}`);
    const saved = await request(app).get("/api/jobs/saved").set("Authorization", `Bearer ${token}`);
    const created = await request(app)
      .post("/api/jobs")
      .set("Authorization", `Bearer ${token}`)
      .send(validJobPayload({ title: "Another" }));
    const updated = await request(app)
      .patch(`/api/jobs/${job._id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Renamed" });

    for (const response of [list, detail, saved, created, updated]) {
      expect(response.status).toBeLessThan(300);
      expect(JSON.stringify(response.body)).not.toContain(user._id.toString());
      expect(response.text).not.toContain("postedBy");
    }

    // The admin view keeps it.
    const adminView = await request(app)
      .get(`/api/admin/jobs/${job._id}`)
      .set("Authorization", `Bearer ${admin.token}`);
    expect(adminView.status).toBe(200);
    expect(adminView.body.job.postedBy).toBe(user._id.toString());
  });

  it("does not expose internal fields on public company, freelancer or category responses", async () => {
    const { user, token } = await createUserWithToken();
    await Company.create({ name: "Acme", createdBy: user._id });
    await Freelancer.create({ ...validFreelancerPayload(), user: user._id });
    await Job.create({ ...validJobPayload(), reviewStatus: "published" });

    const companies = await request(app).get("/api/companies");
    const company = await request(app).get("/api/companies/acme");
    const freelancers = await request(app).get("/api/freelancers").set("Authorization", `Bearer ${token}`);
    const categories = await request(app).get("/api/categories");

    for (const response of [companies, company, freelancers, categories]) {
      expect(response.status).toBe(200);
      expect(response.text).not.toMatch(/createdBy|"user"|__v|createdAt|updatedAt|postedBy/);
      expect(response.text).not.toContain(user._id.toString());
    }
  });
});

describe("validation error sanitization", () => {
  it("POST /api/jobs: enum failure lists allowed values, not the submitted value or schema internals", async () => {
    const { token } = await createUserWithToken();

    const response = await request(app)
      .post("/api/jobs")
      .set("Authorization", `Bearer ${token}`)
      .send(validJobPayload({ employmentType: "EVIL-ENUM-VALUE" }));

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("VALIDATION_ERROR");
    expect(response.body.fields.employmentType).toContain("Full Time");
    expect(response.body.message).toContain("employmentType");
    expectNoLeak(response.body, ["EVIL-ENUM-VALUE", "`"]);
  });

  it("POST /api/jobs: cast failure does not echo the value", async () => {
    const { token } = await createUserWithToken();

    const response = await request(app)
      .post("/api/jobs")
      .set("Authorization", `Bearer ${token}`)
      .send(validJobPayload({ salaryMin: "not-a-number-XYZ" }));

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("VALIDATION_ERROR");
    expect(Object.keys(response.body.fields)).toEqual(["salaryMin"]);
    expectNoLeak(response.body, ["not-a-number-XYZ"]);
  });

  it("POST /api/jobs: keeps authored validator messages", async () => {
    const { token } = await createUserWithToken();

    const response = await request(app)
      .post("/api/jobs")
      .set("Authorization", `Bearer ${token}`)
      .send(validJobPayload({ applicationLink: "javascript:alert(1)" }));

    expect(response.status).toBe(400);
    expect(response.body.fields.applicationLink).toBe("applicationLink must be an http(s) URL.");
    expectNoLeak(response.body, ["javascript:alert"]);
  });

  it("PATCH /api/jobs/:id: validation failure is sanitized too", async () => {
    const { user, token } = await createUserWithToken();
    const job = await Job.create({ ...validJobPayload(), reviewStatus: "published", postedBy: user._id });

    const response = await request(app)
      .patch(`/api/jobs/${job._id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "x".repeat(500) });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("VALIDATION_ERROR");
    expect(response.body.fields.title).toBe("title must be at most 200 characters.");
    expectNoLeak(response.body, ["xxxxxxxxxx"]);
  });

  it("POST /api/freelancers: invalid enum and number are sanitized", async () => {
    const { token } = await createUserWithToken();

    const response = await request(app)
      .post("/api/freelancers")
      .set("Authorization", `Bearer ${token}`)
      .send(validFreelancerPayload({ availability: "SECRET-AVAIL", rating: 99 }));

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("VALIDATION_ERROR");
    expect(response.body.fields.availability).toContain("Available now");
    expect(response.body.fields.rating).toBe("rating must be at most 5.");
    expectNoLeak(response.body, ["SECRET-AVAIL"]);
  });

  it("PATCH /api/freelancers/:id: validation failure is sanitized", async () => {
    const { user, token } = await createUserWithToken();
    const freelancer = await Freelancer.create({ ...validFreelancerPayload(), user: user._id });

    const response = await request(app)
      .patch(`/api/freelancers/${freelancer._id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ handles: [{ platform: "MySpace-SECRET", href: "https://x.example" }] });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("VALIDATION_ERROR");
    expectNoLeak(response.body, ["MySpace-SECRET"]);
  });

  it("POST /api/companies: validation failure is sanitized", async () => {
    const { token } = await createUserWithToken();

    const response = await request(app)
      .post("/api/companies")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Acme", website: "javascript:alert(1)" });

    expect(response.status).toBe(400);
    expect(response.body.fields.website).toBe("website must be an http(s) URL.");
    expectNoLeak(response.body, ["javascript:alert"]);
  });

  it("POST /api/companies: a duplicate name is a generic 409 without index or key details", async () => {
    const { token } = await createUserWithToken();
    await Company.create({ name: "Dupe Co" });

    const response = await request(app)
      .post("/api/companies")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Dupe Co" });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ message: "A company with this name already exists." });
  });

  it("admin approve returns sanitized VALIDATION_ERROR fields", async () => {
    const admin = await createUserWithToken({ role: "admin", email: "sec-admin2@example.com" });
    const job = await Job.create({ ...validJobPayload(), reviewStatus: "pending_review" });

    const response = await request(app)
      .post(`/api/admin/jobs/${job._id}/approve`)
      .set("Authorization", `Bearer ${admin.token}`)
      .send({
        expectedUpdatedAt: job.updatedAt.toISOString(),
        edits: { employmentType: "ADMIN-SECRET-ENUM" },
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("VALIDATION_ERROR");
    expect(response.body.fields.employmentType).toContain("Full Time");
    expectNoLeak(response.body, ["ADMIN-SECRET-ENUM", "`"]);
  });

  it("register: whitespace-only names are a 400, not a 500", async () => {
    const response = await request(app).post("/api/auth/register").send({
      firstName: "   ",
      lastName: "Person",
      email: "blank-name@example.com",
      password: "Strong123",
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("VALIDATION_ERROR");
    expectNoLeak(response.body);
  });
});

describe("toFieldErrors", () => {
  it("maps Mongoose errors to { field: friendly message } only", async () => {
    const job = new Job({
      title: "",
      employmentType: "SECRET-TYPE",
      salaryMin: "SECRET-NUMBER",
      applicationLink: "ftp://secret.example",
      description: "ok",
      company: "c",
      location: "l",
      category: "x",
    });
    const error = await job.validate().catch((e) => e);

    const fields = toFieldErrors(error);

    expect(fields.title).toBe("Job title is required");
    expect(fields.employmentType).toBe(
      "employmentType must be one of: Full Time, Part Time, Contract, Internship, Temporary, Freelance."
    );
    expect(fields.salaryMin).toBe("salaryMin has an invalid value.");
    expect(fields.applicationLink).toBe("applicationLink must be an http(s) URL.");

    const serialized = JSON.stringify(validationErrorBody(error));
    expect(serialized).not.toMatch(/SECRET|Job validation failed|enum value|Cast to/);
  });

  it("replaces Mongoose's default required message and hides a throwing validator's text", () => {
    const fields = toFieldErrors({
      errors: {
        handles: { kind: "required", message: "Path `handles` is required.", properties: {} },
        custom: {
          kind: "user defined",
          message: "internal /srv/app/path blew up",
          properties: { reason: new Error("internal /srv/app/path blew up") },
        },
        "weird path with `ticks`": { kind: "required", message: "x", properties: {} },
      },
    });

    expect(fields.handles).toBe("handles is required.");
    expect(fields.custom).toBe("custom is invalid.");
    expect(fields.value).toBe("x");
    expect(Object.keys(fields)).not.toContain("weird path with `ticks`");
  });

  it("caps the number of reported fields", () => {
    const errors = Object.fromEntries(
      Array.from({ length: 50 }, (_, i) => [`f${i}`, { kind: "required", message: "x", properties: {} }])
    );

    expect(Object.keys(toFieldErrors({ errors })).length).toBeLessThanOrEqual(20);
  });
});

describe("JWT handling", () => {
  it("signs tokens with HS256", async () => {
    const decoded = jwt.decode(generateToken(new mongoose.Types.ObjectId().toString()), { complete: true });
    expect(decoded.header.alg).toBe("HS256");
  });

  it("rejects a token signed with another algorithm even when the secret matches", async () => {
    const { user } = await createUserWithToken();
    const forged = jwt.sign({ id: user._id.toString() }, process.env.JWT_SECRET, { algorithm: "HS512" });

    const me = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${forged}`);
    expect(me.status).toBe(401);
  });

  it("rejects an unsigned (alg none) token", async () => {
    const { user } = await createUserWithToken();
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encode({ alg: "none", typ: "JWT" })}.${encode({ id: user._id.toString() })}.`;

    const me = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${unsigned}`);
    expect(me.status).toBe(401);
  });

  it("an HS512 token is treated as anonymous on optional-auth routes", async () => {
    const { user } = await createUserWithToken();
    const job = await Job.create({ ...validJobPayload(), reviewStatus: "published" });
    await request(app)
      .post(`/api/jobs/${job._id}/save`)
      .set("Authorization", `Bearer ${generateToken(user._id)}`);
    const forged = jwt.sign({ id: user._id.toString() }, process.env.JWT_SECRET, { algorithm: "HS512" });

    const response = await request(app).get(`/api/jobs/${job._id}`).set("Authorization", `Bearer ${forged}`);

    expect(response.status).toBe(200);
    expect(response.body.job.saved).toBe(false);
  });

  it("startServer refuses to start without JWT_SECRET", async () => {
    const previous = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;

    try {
      await expect(startServer()).rejects.toThrow("JWT_SECRET is not set");
    } finally {
      process.env.JWT_SECRET = previous;
    }
  });
});

describe("operator / non-string payloads", () => {
  it.each([
    ["login email", "/api/auth/login", { email: { $ne: null }, password: "Strong123" }],
    ["login password", "/api/auth/login", { email: "a@example.com", password: { $ne: null } }],
    ["register email", "/api/auth/register", { firstName: "A", lastName: "B", email: { $gt: "" }, password: "Strong123" }],
    ["register password", "/api/auth/register", { firstName: "A", lastName: "B", email: "a@example.com", password: ["Strong123"] }],
    ["register name", "/api/auth/register", { firstName: { $ne: 1 }, lastName: "B", email: "a@example.com", password: "Strong123" }],
    ["forgot-password email", "/api/auth/forgot-password", { email: { $ne: null } }],
    ["reset-password token", "/api/auth/reset-password", { token: { $ne: null }, password: "Strong123" }],
    ["reset-password password", "/api/auth/reset-password", { token: "abc", password: { $ne: null } }],
    ["verify-email token", "/api/auth/verify-email", { token: { $ne: null } }],
    ["verify-email code", "/api/auth/verify-email", { email: "a@example.com", code: { $ne: null } }],
    ["resend-verification email", "/api/auth/resend-verification", { email: { $ne: null } }],
  ])("%s as an object/array returns 400 INVALID_INPUT", async (_name, path, body) => {
    const response = await request(app).post(path).send(body);

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("INVALID_INPUT");
    expectNoLeak(response.body);
  });

  it("an operator email does not match an existing account on login", async () => {
    await createUserWithToken({ email: "victim@example.com" });

    const response = await request(app)
      .post("/api/auth/login")
      .send({ email: { $ne: null }, password: "anything" });

    expect(response.status).toBe(400);
    expect(response.body.token).toBeUndefined();
  });

  it("array-valued query filters are ignored instead of causing a 500", async () => {
    const { token } = await createUserWithToken();
    await Freelancer.create(validFreelancerPayload());
    await Company.create({ name: "Acme" });
    await Job.create({ ...validJobPayload(), reviewStatus: "published" });

    const freelancers = await request(app)
      .get("/api/freelancers?category=Development&category=Design&q=a&q=b")
      .set("Authorization", `Bearer ${token}`);
    const companies = await request(app).get("/api/companies?keyword=a&keyword=b");
    const jobs = await request(app).get("/api/jobs?category=Design&category=Other&company[$ne]=x&keyword=a&keyword=b");

    expect(freelancers.status).toBe(200);
    expect(freelancers.body.freelancers).toHaveLength(1);
    expect(companies.status).toBe(200);
    expect(companies.body.companies).toHaveLength(1);
    expect(jobs.status).toBe(200);
    expect(jobs.body.jobs).toHaveLength(1);
  });
});
