import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const { default: app } = await import("../app.js");
const { default: Job } = await import("../src/models/job.model.js");

let mongoServer;

const TOTAL = 9;
const SORTS = ["MOST_RECENT", "OLDEST", "HIGHEST_SALARY", "MOST_APPLICANTS"];

const fetchAll = async (sort, limit) => {
  const ids = [];
  for (let page = 1; page <= Math.ceil(TOTAL / limit); page += 1) {
    const response = await request(app).get("/api/jobs").query({ sort, page, limit });
    expect(response.status).toBe(200);
    ids.push(...response.body.jobs.map((job) => job.id));
  }
  return ids;
};

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  // Every job ties on createdAt, salary and applicants: the worst case for paging.
  const sameTime = new Date("2026-01-01T00:00:00.000Z");
  for (let i = 0; i < TOTAL; i += 1) {
    await Job.create({
      title: `Job ${i}`,
      company: "Acme",
      location: "Lagos, Nigeria",
      employmentType: "Full Time",
      salaryMin: 100000,
      salaryMax: 200000,
      category: "Design",
      description: "Design things.",
      applicationLink: "https://example.com/apply",
      reviewStatus: "published",
      createdAt: sameTime,
    });
  }
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe("paging through jobs that tie on every sort field", () => {
  it.each(SORTS)("%s returns every job exactly once across pages", async (sort) => {
    const ids = await fetchAll(sort, 4);
    expect(ids).toHaveLength(TOTAL);
    expect(new Set(ids).size).toBe(TOTAL);
  });

  it.each(SORTS)("%s gives the same order every time", async (sort) => {
    expect(await fetchAll(sort, 4)).toEqual(await fetchAll(sort, 4));
  });

  it("page size does not change the order", async () => {
    expect(await fetchAll("MOST_RECENT", 2)).toEqual(await fetchAll("MOST_RECENT", 5));
  });

  it("oldest is the reverse of most recent when everything ties", async () => {
    const recent = await fetchAll("MOST_RECENT", 3);
    const oldest = await fetchAll("OLDEST", 3);
    expect(oldest).toEqual([...recent].reverse());
  });
});
