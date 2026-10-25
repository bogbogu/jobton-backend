import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const { default: app } = await import("../app.js");
const { default: NewsletterSubscriber } = await import("../src/models/newsletterSubscriber.model.js");

let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

afterEach(async () => {
  await NewsletterSubscriber.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe("Newsletter routes", () => {
  it("subscribes a new email", async () => {
    const response = await request(app)
      .post("/api/newsletter/subscribe")
      .send({ email: "Reader@Example.com" });

    expect(response.status).toBe(201);
    const stored = await NewsletterSubscriber.findOne({ email: "reader@example.com" });
    expect(stored).not.toBeNull();
  });

  it("rejects an invalid email", async () => {
    const response = await request(app).post("/api/newsletter/subscribe").send({ email: "not-an-email" });

    expect(response.status).toBe(400);
  });

  it("rejects a non-string email such as an array", async () => {
    const response = await request(app).post("/api/newsletter/subscribe").send({ email: ["reader@example.com"] });

    expect(response.status).toBe(400);
  });

  it("is idempotent for an already-subscribed email", async () => {
    await NewsletterSubscriber.create({ email: "reader@example.com" });

    const response = await request(app)
      .post("/api/newsletter/subscribe")
      .send({ email: "reader@example.com" });

    expect(response.status).toBe(200);
    expect(await NewsletterSubscriber.countDocuments({ email: "reader@example.com" })).toBe(1);
  });
});
