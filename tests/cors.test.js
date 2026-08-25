import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// app.js reads CORS_ALLOWED_ORIGINS (falling back to FRONTEND_URL) once at
// import time to build its CORS allow-list, so this needs its own env value
// and a fresh import — not the shared "http://localhost:5173" set in
// tests/setup.js for the rest of the suite. See tests/cors-fallback.test.js
// for the "CORS_ALLOWED_ORIGINS unset, falls back to FRONTEND_URL" case.
process.env.FRONTEND_URL = "https://jobton-eosin.vercel.app";
process.env.CORS_ALLOWED_ORIGINS = "https://jobton-eosin.vercel.app/, http://localhost:5174";

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

describe("CORS allow-list", () => {
  it("allows an origin listed in CORS_ALLOWED_ORIGINS", async () => {
    const response = await request(app)
      .get("/api/jobs")
      .set("Origin", "http://localhost:5174");

    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:5174");
  });

  it("strips a trailing slash from an allowed origin so the bare origin still matches", async () => {
    // CORS_ALLOWED_ORIGINS above has a trailing slash on this one — a real
    // Origin header never has one, so without normalization this would
    // never match (this is exactly what broke when FRONTEND_URL, which
    // legitimately has a trailing slash in some deployments, was briefly
    // reused directly as the CORS source before CORS_ALLOWED_ORIGINS existed).
    const response = await request(app)
      .get("/api/jobs")
      .set("Origin", "https://jobton-eosin.vercel.app");

    expect(response.headers["access-control-allow-origin"]).toBe("https://jobton-eosin.vercel.app");
  });

  it("does not set an allow-origin header for an origin outside the allow-list", async () => {
    const response = await request(app)
      .get("/api/jobs")
      .set("Origin", "https://evil.example.com");

    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(response.status).toBe(200); // fails closed without throwing/crashing
  });

  it("allows requests with no Origin header (curl, server-to-server, Supertest)", async () => {
    const response = await request(app).get("/api/jobs");

    expect(response.status).toBe(200);
  });
});
