import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/email.service.js", () => {
  return {
    validateEmailConfig: vi.fn(() => ({
      isValid: true,
      missingVars: [],
      invalidVars: [],
    })),
    sendVerificationEmail: vi.fn(async () => ({ id: "mock-verification-email" })),
    sendResetPasswordEmail: vi.fn(async () => ({ id: "mock-reset-email" })),
  };
});

const { default: app } = await import("../app.js");
const { default: User } = await import("../src/models/user.model.js");
const { hashValue } = await import("../src/utils/authToken.utils.js");
const {
  __resetResendThrottleStores,
} = await import("../src/middleware/resendVerificationThrottle.middleware.js");
const {
  sendVerificationEmail,
  sendResetPasswordEmail,
} = await import("../src/utils/email.service.js");

let mongoServer;

const createVerifiedUser = async ({
  firstName = "Jane",
  lastName = "Doe",
  email = "jane@example.com",
  passwordHash,
} = {}) => {
  return User.create({
    firstName,
    lastName,
    email,
    password: passwordHash,
    isVerified: true,
  });
};

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();
  await mongoose.connect(uri);
});

afterEach(async () => {
  vi.clearAllMocks();
  __resetResendThrottleStores();
  await User.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe("Auth routes", () => {
  it("register -> verify by code should work", async () => {
    const registerResponse = await request(app).post("/api/auth/register").send({
      firstName: "Benedict",
      lastName: "Ogbogu",
      email: "benedict@example.com",
      password: "Strong123",
    });

    expect(registerResponse.status).toBe(201);
    expect(registerResponse.body.token).toBeUndefined();
    expect(registerResponse.body.user.isVerified).toBe(false);
    expect(sendVerificationEmail).toHaveBeenCalledTimes(1);

    const verificationPayload = sendVerificationEmail.mock.calls[0][0];

    const verifyResponse = await request(app).post("/api/auth/verify-email").send({
      email: "benedict@example.com",
      code: verificationPayload.verificationCode,
    });

    expect(verifyResponse.status).toBe(200);
    expect(verifyResponse.body.message).toBe("Email verified successfully.");
  });

  it("verify by token should work", async () => {
    await request(app).post("/api/auth/register").send({
      firstName: "Token",
      lastName: "User",
      email: "token@example.com",
      password: "Strong123",
    });

    const verificationPayload = sendVerificationEmail.mock.calls[0][0];

    const verifyResponse = await request(app).post("/api/auth/verify-email").send({
      token: verificationPayload.verificationToken,
    });

    expect(verifyResponse.status).toBe(200);
    expect(verifyResponse.body.message).toBe("Email verified successfully.");
  });

  it("verify-email should return invalid token error semantics", async () => {
    const response = await request(app).post("/api/auth/verify-email").send({
      token: "bad-token",
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("INVALID_TOKEN");
  });

  it("verify-email should return invalid code error semantics", async () => {
    await request(app).post("/api/auth/register").send({
      firstName: "Code",
      lastName: "User",
      email: "code@example.com",
      password: "Strong123",
    });

    const response = await request(app).post("/api/auth/verify-email").send({
      email: "code@example.com",
      code: "111111",
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("INVALID_CODE");
  });

  it("verify-email should return expired token semantics", async () => {
    const rawToken = "expired-token";

    await User.create({
      firstName: "Expired",
      lastName: "User",
      email: "expired@example.com",
      password: "$2a$10$eBv3z6r8E0FQn2mM1gM4QeSxwE5jQhTs6f6lJ7mUv7zNli3WfYB0m",
      emailVerificationToken: hashValue(rawToken),
      emailVerificationCode: hashValue("123456"),
      emailVerificationExpiresAt: new Date(Date.now() - 60_000),
      isVerified: false,
    });

    const response = await request(app).post("/api/auth/verify-email").send({
      token: rawToken,
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("EXPIRED_TOKEN");
  });

  it("verify-email should return expired code semantics", async () => {
    await User.create({
      firstName: "Expired",
      lastName: "Code",
      email: "expired-code@example.com",
      password: "$2a$10$eBv3z6r8E0FQn2mM1gM4QeSxwE5jQhTs6f6lJ7mUv7zNli3WfYB0m",
      emailVerificationToken: hashValue("unused-token"),
      emailVerificationCode: hashValue("333333"),
      emailVerificationExpiresAt: new Date(Date.now() - 60_000),
      isVerified: false,
    });

    const response = await request(app).post("/api/auth/verify-email").send({
      email: "expired-code@example.com",
      code: "333333",
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("EXPIRED_CODE");
  });

  it("verify-email should return already-verified semantics", async () => {
    const rawToken = "already-verified-token";

    await User.create({
      firstName: "Verified",
      lastName: "User",
      email: "verified@example.com",
      password: "$2a$10$eBv3z6r8E0FQn2mM1gM4QeSxwE5jQhTs6f6lJ7mUv7zNli3WfYB0m",
      emailVerificationToken: hashValue(rawToken),
      emailVerificationCode: hashValue("222222"),
      emailVerificationExpiresAt: new Date(Date.now() + 60_000),
      isVerified: true,
    });

    const response = await request(app).post("/api/auth/verify-email").send({
      token: rawToken,
    });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe("ALREADY_VERIFIED");
  });

  it("resend verification should send email for unverified user", async () => {
    await request(app).post("/api/auth/register").send({
      firstName: "Resend",
      lastName: "Target",
      email: "resend@example.com",
      password: "Strong123",
    });

    vi.clearAllMocks();

    const response = await request(app)
      .post("/api/auth/resend-verification")
      .send({ email: "resend@example.com" });

    expect(response.status).toBe(200);
    expect(sendVerificationEmail).toHaveBeenCalledTimes(1);
  });

  it("resend verification should not enumerate users", async () => {
    const response = await request(app)
      .post("/api/auth/resend-verification")
      .send({ email: "missing@example.com" });

    expect(response.status).toBe(200);
    expect(response.body.message).toContain("If that email exists");
    expect(sendVerificationEmail).not.toHaveBeenCalled();
  });

  it("resend verification should be rate-limited by email", async () => {
    await request(app).post("/api/auth/register").send({
      firstName: "Rate",
      lastName: "Limit",
      email: "ratelimit@example.com",
      password: "Strong123",
    });

    vi.clearAllMocks();

    for (let i = 0; i < 5; i += 1) {
      const response = await request(app)
        .post("/api/auth/resend-verification")
        .send({ email: "ratelimit@example.com" });

      expect(response.status).toBe(200);
    }

    const blockedResponse = await request(app)
      .post("/api/auth/resend-verification")
      .send({ email: "ratelimit@example.com" });

    expect(blockedResponse.status).toBe(429);
    expect(blockedResponse.body.error).toBe("RATE_LIMITED");
  });

  it("login should block unverified users with machine-readable error and no token", async () => {
    await request(app).post("/api/auth/register").send({
      firstName: "Login",
      lastName: "Block",
      email: "login-block@example.com",
      password: "Strong123",
    });

    const loginResponse = await request(app).post("/api/auth/login").send({
      email: "login-block@example.com",
      password: "Strong123",
    });

    expect(loginResponse.status).toBe(403);
    expect(loginResponse.body.error).toBe("EMAIL_NOT_VERIFIED");
    expect(loginResponse.body.token).toBeUndefined();
  });

  it("forgot-password should be non-enumerating", async () => {
    const unknownResponse = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: "unknown@example.com" });

    expect(unknownResponse.status).toBe(200);

    await createVerifiedUser({
      email: "known@example.com",
      passwordHash:
        "$2a$10$TO4kL8QiRkWvAf0x8zrwEelz9eKcm6jWnLmZ8g8uhtjVfKq7H4VTu",
    });

    const knownResponse = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: "known@example.com" });

    expect(knownResponse.status).toBe(200);
    expect(knownResponse.body.message).toBe(unknownResponse.body.message);
    expect(sendResetPasswordEmail).toHaveBeenCalledTimes(1);
  });

  it("reset-password should reject invalid token", async () => {
    const response = await request(app).post("/api/auth/reset-password").send({
      token: "invalid-reset-token",
      password: "Strong123",
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("INVALID_TOKEN");
  });

  it("reset-password should reject expired token", async () => {
    const rawToken = "expired-reset-token";

    await User.create({
      firstName: "Reset",
      lastName: "Expired",
      email: "reset-expired@example.com",
      password: "$2a$10$eBv3z6r8E0FQn2mM1gM4QeSxwE5jQhTs6f6lJ7mUv7zNli3WfYB0m",
      isVerified: true,
      passwordResetToken: hashValue(rawToken),
      passwordResetExpiresAt: new Date(Date.now() - 60_000),
      passwordResetUsedAt: null,
    });

    const response = await request(app).post("/api/auth/reset-password").send({
      token: rawToken,
      password: "Strong123",
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("EXPIRED_TOKEN");
  });

  it("reset-password should reject used token", async () => {
    const rawToken = "used-reset-token";

    await User.create({
      firstName: "Reset",
      lastName: "Used",
      email: "reset-used@example.com",
      password: "$2a$10$eBv3z6r8E0FQn2mM1gM4QeSxwE5jQhTs6f6lJ7mUv7zNli3WfYB0m",
      isVerified: true,
      passwordResetToken: hashValue(rawToken),
      passwordResetExpiresAt: new Date(Date.now() + 60_000),
      passwordResetUsedAt: new Date(),
    });

    const response = await request(app).post("/api/auth/reset-password").send({
      token: rawToken,
      password: "Strong123",
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("USED_TOKEN");
  });

  it("reset-password should enforce password policy", async () => {
    const rawToken = "policy-reset-token";

    await User.create({
      firstName: "Reset",
      lastName: "Policy",
      email: "reset-policy@example.com",
      password: "$2a$10$eBv3z6r8E0FQn2mM1gM4QeSxwE5jQhTs6f6lJ7mUv7zNli3WfYB0m",
      isVerified: true,
      passwordResetToken: hashValue(rawToken),
      passwordResetExpiresAt: new Date(Date.now() + 60_000),
      passwordResetUsedAt: null,
    });

    const response = await request(app).post("/api/auth/reset-password").send({
      token: rawToken,
      password: "weak",
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("INVALID_PASSWORD");
  });

  it("forgot-password -> reset-password should complete flow", async () => {
    await createVerifiedUser({
      email: "flow@example.com",
      passwordHash:
        "$2a$10$TO4kL8QiRkWvAf0x8zrwEelz9eKcm6jWnLmZ8g8uhtjVfKq7H4VTu",
    });

    const forgotResponse = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: "flow@example.com" });

    expect(forgotResponse.status).toBe(200);
    expect(sendResetPasswordEmail).toHaveBeenCalledTimes(1);

    const resetToken = sendResetPasswordEmail.mock.calls[0][0].resetToken;

    const resetResponse = await request(app).post("/api/auth/reset-password").send({
      token: resetToken,
      password: "NewStrong123",
    });

    expect(resetResponse.status).toBe(200);
    expect(resetResponse.body.message).toBe("Password reset successful.");
  });
});
