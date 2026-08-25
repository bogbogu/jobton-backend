import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";

const { default: app } = await import("../app.js");
const { default: Job } = await import("../src/models/job.model.js");

let mongoServer;

const baseJob = (overrides = {}) => ({
  title: "Product Designer",
  company: "Flutterwave",
  location: "Lagos, Nigeria",
  employmentType: "Full-time",
  salaryMin: 500000,
  category: "Design",
  description: "Design things.",
  applicationLink: "https://example.com/apply",
  ...overrides,
});

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();
  await mongoose.connect(uri);
});

afterEach(async () => {
  await Job.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe("Category routes", () => {
  it("returns an empty list when there are no jobs", async () => {
    const response = await request(app).get("/api/categories");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      message: "Categories retrieved successfully.",
      categories: [],
    });
  });

  it("groups jobs by category and sorts by job count descending", async () => {
    await Job.create(baseJob({ category: "Design" }));
    await Job.create(baseJob({ category: "Design", title: "Senior Designer" }));
    await Job.create(baseJob({ category: "Engineering", title: "Backend Engineer" }));

    const response = await request(app).get("/api/categories");

    expect(response.status).toBe(200);
    expect(response.body.categories).toEqual([
      { title: "Design", jobCount: 2 },
      { title: "Engineering", jobCount: 1 },
    ]);
  });
});
