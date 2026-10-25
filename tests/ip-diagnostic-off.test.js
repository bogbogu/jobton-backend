import request from "supertest";
import { describe, expect, it } from "vitest";

delete process.env.TRUST_PROXY_DEBUG;
const { default: app } = await import("../app.js");

describe("temporary IP diagnostic route (default)", () => {
  it("does not exist unless TRUST_PROXY_DEBUG=1", async () => {
    const response = await request(app).get("/api/_diag/ip");
    expect(response.status).toBe(404);
  });
});
