import request from "supertest";
import { describe, expect, it } from "vitest";

process.env.TRUST_PROXY_DEBUG = "1";
const { default: app } = await import("../app.js");

describe("temporary IP diagnostic route (enabled)", () => {
  it("shows only the caller's own request", async () => {
    const response = await request(app).get("/api/_diag/ip").set("X-Forwarded-For", "203.0.113.9");
    expect(response.status).toBe(200);
    expect(Object.keys(response.body).sort()).toEqual(
      ["cfConnectingIp", "instance", "ip", "ips", "trueClientIp", "xForwardedFor"]
    );
    expect(response.headers["cache-control"]).toBe("no-store");
  });
});
