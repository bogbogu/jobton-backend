import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const { default: app } = await import("../app.js");
const { default: User } = await import("../src/models/user.model.js");
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

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

afterEach(async () => {
  await Company.deleteMany({});
  await User.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe("Company routes", () => {
  it("generates a slug from the company name on create", async () => {
    const { token } = await createUserWithToken();

    const response = await request(app)
      .post("/api/companies")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Flutterwave Inc.", domain: "flutterwave.com" });

    expect(response.status).toBe(201);
    expect(response.body.company.slug).toBe("flutterwave-inc");
  });

  it("requires authentication to create a company", async () => {
    const response = await request(app).post("/api/companies").send({ name: "Flutterwave" });
    expect(response.status).toBe(401);
  });

  it("rejects a duplicate company name", async () => {
    const { token } = await createUserWithToken();

    await request(app).post("/api/companies").set("Authorization", `Bearer ${token}`).send({ name: "Flutterwave" });
    const second = await request(app)
      .post("/api/companies")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Flutterwave" });

    expect(second.status).toBe(409);
  });

  it("GET /api/companies/:slug returns 404 for an unknown slug", async () => {
    const response = await request(app).get("/api/companies/does-not-exist");
    expect(response.status).toBe(404);
  });

  it("GET /api/companies/:slug is public and returns the company", async () => {
    await Company.create({ name: "Paystack", industry: "Fintech" });

    const response = await request(app).get("/api/companies/paystack");

    expect(response.status).toBe(200);
    expect(response.body.company).toMatchObject({ name: "Paystack", slug: "paystack", industry: "Fintech" });
  });

  it("only an admin can update or delete a company", async () => {
    await Company.create({ name: "Paystack" });
    const { token: userToken } = await createUserWithToken({ email: "regular@example.com" });
    const { token: adminToken } = await createUserWithToken({ email: "admin@example.com", role: "admin" });

    const userAttempt = await request(app)
      .patch("/api/companies/paystack")
      .set("Authorization", `Bearer ${userToken}`)
      .send({ description: "Hijacked" });
    expect(userAttempt.status).toBe(403);

    const adminAttempt = await request(app)
      .patch("/api/companies/paystack")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ description: "Payments infrastructure for Africa." });
    expect(adminAttempt.status).toBe(200);
    expect(adminAttempt.body.company.description).toBe("Payments infrastructure for Africa.");

    const deleteAttempt = await request(app)
      .delete("/api/companies/paystack")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(deleteAttempt.status).toBe(200);
    expect(await Company.findOne({ slug: "paystack" })).toBeNull();
  });

  it("lists companies filtered by keyword", async () => {
    await Company.create({ name: "Paystack" });
    await Company.create({ name: "Flutterwave" });

    const response = await request(app).get("/api/companies").query({ keyword: "pay" });

    expect(response.body.companies).toHaveLength(1);
    expect(response.body.companies[0].name).toBe("Paystack");
  });
});
