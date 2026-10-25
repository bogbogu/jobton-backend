import request from "supertest";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { MongoMemoryServer } from "mongodb-memory-server";
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/email.service.js", () => ({
  validateEmailConfig: vi.fn(() => ({ isValid: true, missingVars: [], invalidVars: [] })),
  sendVerificationEmail: vi.fn(async () => ({ id: "mock-verification-email" })),
  sendResetPasswordEmail: vi.fn(async () => ({ id: "mock-reset-email" })),
}));

const { default: app } = await import("../app.js");
const { default: User } = await import("../src/models/user.model.js");
const { sendResetPasswordEmail } = await import("../src/utils/email.service.js");
const { __resetAuthRateLimitStores } = await import("../src/middleware/authRateLimit.middleware.js");
const { __resetResendThrottleStores } = await import("../src/middleware/resendVerificationThrottle.middleware.js");

let mongoServer;
let passwordHash;

// A login issued `secondsAgo` seconds in the past.
const tokenIssuedAgo = (userId, secondsAgo) =>
  jwt.sign({ id: String(userId), iat: Math.floor(Date.now() / 1000) - secondsAgo }, process.env.JWT_SECRET, {
    algorithm: "HS256",
    expiresIn: "7d",
  });

const createUser = (email) => User.create({ firstName: "Jane", lastName: "Doe", email, password: passwordHash, isVerified: true });

const resetPassword = async (email, password) => {
  await request(app).post("/api/auth/forgot-password").send({ email });
  const { resetToken } = sendResetPasswordEmail.mock.calls.at(-1)[0];
  return request(app).post("/api/auth/reset-password").send({ token: resetToken, password });
};

beforeAll(async () => {
  passwordHash = await bcrypt.hash("OldStrong123", 4);
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

afterEach(async () => {
  vi.clearAllMocks();
  __resetAuthRateLimitStores();
  __resetResendThrottleStores();
  await User.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe("sessions end when the password is reset", () => {
  it("an older login stops working after a reset, and a fresh login works", async () => {
    const user = await createUser("revoke@example.com");
    const oldToken = tokenIssuedAgo(user._id, 3600);

    const before = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${oldToken}`);
    expect(before.status).toBe(200);

    const reset = await resetPassword("revoke@example.com", "NewStrong123");
    expect(reset.status).toBe(200);

    const after = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${oldToken}`);
    expect(after.status).toBe(401);

    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: "revoke@example.com", password: "NewStrong123" });
    expect(login.status).toBe(200);

    const fresh = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${login.body.token}`);
    expect(fresh.status).toBe(200);
  });

  it("the old password no longer works", async () => {
    await createUser("old-password@example.com");
    await resetPassword("old-password@example.com", "NewStrong123");

    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: "old-password@example.com", password: "OldStrong123" });
    expect(login.status).toBe(401);
  });

  it("other users' logins are not affected", async () => {
    const resetUser = await createUser("resetter@example.com");
    const other = await createUser("bystander@example.com");
    const otherToken = tokenIssuedAgo(other._id, 3600);

    await resetPassword(resetUser.email, "NewStrong123");

    const response = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${otherToken}`);
    expect(response.status).toBe(200);
  });

  it("a token without an issue time is refused once the password has been reset", async () => {
    const user = await createUser("no-iat@example.com");
    await resetPassword(user.email, "NewStrong123");

    const noIat = jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET, { algorithm: "HS256", noTimestamp: true });
    const response = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${noIat}`);
    expect(response.status).toBe(401);
  });

  it("a stale login is treated as logged out (not an error) on public routes", async () => {
    const user = await createUser("public@example.com");
    const oldToken = tokenIssuedAgo(user._id, 3600);
    await resetPassword(user.email, "NewStrong123");

    const response = await request(app).get("/api/jobs").set("Authorization", `Bearer ${oldToken}`);
    expect(response.status).toBe(200);
  });

  it("the new field is never exposed", async () => {
    const user = await createUser("hidden@example.com");
    await resetPassword(user.email, "NewStrong123");
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: "hidden@example.com", password: "NewStrong123" });

    expect(JSON.stringify(login.body)).not.toContain("passwordChangedAt");
    const me = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${login.body.token}`);
    expect(JSON.stringify(me.body)).not.toContain("passwordChangedAt");
  });
});
