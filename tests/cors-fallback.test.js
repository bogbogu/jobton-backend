import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Deliberately does NOT set CORS_ALLOWED_ORIGINS, to cover the common
// single-frontend deployment: FRONTEND_URL alone should still be enough to
// allow CORS from that origin (see app.js's fallback).
process.env.FRONTEND_URL = "https://jobton-eosin.vercel.app";
delete process.env.CORS_ALLOWED_ORIGINS;

vi.mock("../src/utils/email.service.js", () => ({
  validateEmailConfig: vi.fn(() => ({ isValid: true, missingVars: [], invalidVars: [] })),
  sendVerificationEmail: vi.fn(),
  sendResetPasswordEmail: vi.fn(),
}));

const { default: app } = await import("../app.js");

let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe("CORS allow-list fallback", () => {
  it("allows FRONTEND_URL's origin when CORS_ALLOWED_ORIGINS is unset", async () => {
    const response = await request(app)
      .get("/api/jobs")
      .set("Origin", "https://jobton-eosin.vercel.app");

    expect(response.headers["access-control-allow-origin"]).toBe("https://jobton-eosin.vercel.app");
  });
});
