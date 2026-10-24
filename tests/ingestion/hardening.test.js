import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";

const { parseChannelHtml } = await import("../../src/services/ingestion/telegramParse.js");
const { sanitizeExtraction } = await import("../../src/services/ingestion/extractJob.js");
const { getConfig } = await import("../../src/services/ingestion/config.js");
const { default: app } = await import("../../app.js");
const { default: User } = await import("../../src/models/user.model.js");
const { default: Job } = await import("../../src/models/job.model.js");
const { default: generateToken } = await import("../../src/utils/generateToken.js");

const page = (messageHtml) => `
  <div class="tgme_widget_message_wrap">
    <div class="tgme_widget_message" data-post="tohire_ng/501">
      <div class="tgme_widget_message_text">${messageHtml}</div>
      <time datetime="2026-10-17T10:00:00+00:00"></time>
    </div>
  </div>`;

const timed = (fn) => {
  const start = performance.now();
  const result = fn();
  return { result, ms: performance.now() - start };
};

describe("parser stays linear on hostile pages", () => {
  it("a post with a huge run of spaces before newlines parses quickly", () => {
    const html = page(`Hiring now${" ".repeat(100_000)}<br>Lagos`);
    const { result, ms } = timed(() => parseChannelHtml(html, "tohire_ng"));
    expect(ms).toBeLessThan(500);
    expect(result).toHaveLength(1);
    expect(result[0].text).toContain("Hiring now");
  });

  it("an anchor label made of 100k slashes parses quickly", () => {
    const html = page(`<a href="https://example.com/apply">${"/".repeat(100_000)}</a>`);
    const { ms } = timed(() => parseChannelHtml(html, "tohire_ng"));
    expect(ms).toBeLessThan(500);
  });

  it("still tidies trailing spaces and blank-line runs", () => {
    const html = page("Line one   <br>Line two<br><br><br><br>Line three");
    const [post] = parseChannelHtml(html, "tohire_ng");
    expect(post.text).toBe("Line one\nLine two\n\nLine three");
  });
});

describe("extractor link comparison stays linear", () => {
  it("a link ending in a very long run of slashes is handled quickly", () => {
    const evil = `https://example.com/${"/".repeat(200_000)}`;
    const { ms } = timed(() =>
      sanitizeExtraction(
        { jobs: [{ title: "T", description: "d", applicationLink: evil, skills: [], responsibilities: [], corrections: [], employmentType: "Unknown", workArrangement: "Unknown", salaryCurrency: "Unknown", salaryPeriod: "Unknown" }] },
        { text: "apply at https://example.com/", links: [] }
      )
    );
    expect(ms).toBeLessThan(500);
  });
});

describe("ingestion config", () => {
  it("a set-but-invalid per-run post limit becomes 1, never 0 (Mongo limit(0) means unlimited)", () => {
    const keep = process.env.INGESTION_MAX_POSTS_PER_CHANNEL_RUN;
    try {
      process.env.INGESTION_MAX_POSTS_PER_CHANNEL_RUN = "0";
      expect(getConfig().maxPostsPerChannelRun).toBe(1);
      process.env.INGESTION_MAX_POSTS_PER_CHANNEL_RUN = "-3";
      expect(getConfig().maxPostsPerChannelRun).toBe(1);
      delete process.env.INGESTION_MAX_POSTS_PER_CHANNEL_RUN;
      expect(getConfig().maxPostsPerChannelRun).toBe(40);
    } finally {
      if (keep === undefined) delete process.env.INGESTION_MAX_POSTS_PER_CHANNEL_RUN;
      else process.env.INGESTION_MAX_POSTS_PER_CHANNEL_RUN = keep;
    }
  });
});

describe("owner PATCH with uncastable values", () => {
  let mongoServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
  });

  afterEach(async () => {
    await Job.deleteMany({});
    await User.deleteMany({});
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  it.each([
    ["salaryMin", "abc"],
    ["applicationLink", { a: 1 }],
    ["company", ["a", "b"]],
  ])("rejects %s=%j with 400 and leaves the published job untouched", async (field, value) => {
    const user = await User.create({
      firstName: "Test",
      lastName: "Owner",
      email: "owner@example.com",
      password: "$2a$10$eBv3z6r8E0FQn2mM1gM4QeSxwE5jQhTs6f6lJ7mUv7zNli3WfYB0m",
      isVerified: true,
    });
    const token = generateToken(user._id);
    const job = await Job.create({
      title: "Designer",
      company: "Flutterwave",
      location: "Lagos",
      employmentType: "Full Time",
      salaryMin: 100000,
      category: "Design",
      description: "Design things.",
      applicationLink: "https://flutterwave.com/careers/1",
      postedBy: user._id,
      reviewStatus: "published",
    });

    const response = await request(app)
      .patch(`/api/jobs/${job._id}`)
      .set({ Authorization: `Bearer ${token}` })
      .send({ [field]: value });

    expect(response.status).toBe(400);

    const stored = await Job.collection.findOne({ _id: job._id });
    expect(stored.reviewStatus).toBe("published");
    expect(stored.company).toBe("Flutterwave");
    expect(stored.salaryMin).toBe(100000);
  });
});
