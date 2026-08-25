import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";

const { default: app } = await import("../app.js");
const { default: User } = await import("../src/models/user.model.js");
const { default: Freelancer } = await import("../src/models/freelancer.model.js");
const { default: generateToken } = await import("../src/utils/generateToken.js");

let mongoServer;

const createUserWithToken = async ({ role = "user", email = "freelancer-user@example.com" } = {}) => {
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

const validFreelancerPayload = (overrides = {}) => ({
  name: "Adaeze Okonkwo",
  role: "Frontend Developer",
  category: "Development",
  location: "Lagos, NG",
  availability: "Available now",
  hourlyRate: "$32/hr",
  yearsExperience: 5,
  projectsCompleted: 46,
  rating: 4.9,
  bio: "Builds performant web interfaces.",
  skills: ["React", "TypeScript"],
  email: "adaeze.okonkwo@jobton.dev",
  phone: "+2348103019001",
  handles: [{ platform: "LinkedIn", href: "https://linkedin.com" }],
  ...overrides,
});

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();
  await mongoose.connect(uri);
});

afterEach(async () => {
  await Freelancer.deleteMany({});
  await User.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe("Freelancer routes", () => {
  it("requires authentication for every freelancer route", async () => {
    const list = await request(app).get("/api/freelancers");
    expect(list.status).toBe(401);

    const create = await request(app).post("/api/freelancers").send(validFreelancerPayload());
    expect(create.status).toBe(401);
  });

  it("creates a freelancer profile for an authenticated user", async () => {
    const { token, user } = await createUserWithToken();

    const response = await request(app)
      .post("/api/freelancers")
      .set("Authorization", `Bearer ${token}`)
      .send(validFreelancerPayload());

    expect(response.status).toBe(201);
    expect(response.body.freelancer).toMatchObject({
      name: "Adaeze Okonkwo",
      category: "Development",
      handles: [{ platform: "LinkedIn", href: "https://linkedin.com" }],
    });
    expect(typeof response.body.freelancer.id).toBe("string");

    const stored = await Freelancer.findOne({ email: "adaeze.okonkwo@jobton.dev" });
    expect(stored.user.toString()).toBe(user._id.toString());
  });

  it("rejects a freelancer payload missing required fields", async () => {
    const { token } = await createUserWithToken();

    const response = await request(app)
      .post("/api/freelancers")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Incomplete" });

    expect(response.status).toBe(400);
  });

  it("filters freelancers by category and search query", async () => {
    const { token } = await createUserWithToken();

    await Freelancer.create(validFreelancerPayload());
    await Freelancer.create(
      validFreelancerPayload({
        name: "Tunde Balogun",
        role: "UI/UX Designer",
        category: "Design",
        email: "tunde.balogun@jobton.dev",
        skills: ["Figma"],
      })
    );

    const byCategory = await request(app)
      .get("/api/freelancers")
      .set("Authorization", `Bearer ${token}`)
      .query({ category: "Design" });
    expect(byCategory.body.freelancers).toHaveLength(1);
    expect(byCategory.body.freelancers[0].name).toBe("Tunde Balogun");

    const byQuery = await request(app)
      .get("/api/freelancers")
      .set("Authorization", `Bearer ${token}`)
      .query({ q: "React" });
    expect(byQuery.body.freelancers).toHaveLength(1);
    expect(byQuery.body.freelancers[0].name).toBe("Adaeze Okonkwo");
  });

  it("GET /api/freelancers/:id returns 404 for a missing or invalid id", async () => {
    const { token } = await createUserWithToken();

    const missing = await request(app)
      .get(`/api/freelancers/${new mongoose.Types.ObjectId()}`)
      .set("Authorization", `Bearer ${token}`);
    expect(missing.status).toBe(404);

    const invalid = await request(app)
      .get("/api/freelancers/not-a-valid-id")
      .set("Authorization", `Bearer ${token}`);
    expect(invalid.status).toBe(404);
  });

  it("only the owning user or an admin can update or delete a freelancer profile", async () => {
    const { token: ownerToken, user: owner } = await createUserWithToken({ email: "owner-fl@example.com" });
    const { token: strangerToken } = await createUserWithToken({ email: "stranger-fl@example.com" });
    const { token: adminToken } = await createUserWithToken({ email: "admin-fl@example.com", role: "admin" });

    const freelancer = await Freelancer.create({ ...validFreelancerPayload(), user: owner._id });

    const strangerAttempt = await request(app)
      .patch(`/api/freelancers/${freelancer._id}`)
      .set("Authorization", `Bearer ${strangerToken}`)
      .send({ bio: "Hijacked bio" });
    expect(strangerAttempt.status).toBe(403);

    const ownerAttempt = await request(app)
      .patch(`/api/freelancers/${freelancer._id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ bio: "Updated by owner" });
    expect(ownerAttempt.status).toBe(200);
    expect(ownerAttempt.body.freelancer.bio).toBe("Updated by owner");

    const adminDelete = await request(app)
      .delete(`/api/freelancers/${freelancer._id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(adminDelete.status).toBe(200);

    const afterDelete = await Freelancer.findById(freelancer._id);
    expect(afterDelete).toBeNull();
  });
});
