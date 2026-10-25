import express from "express";
import request from "supertest";
import rateLimit, { MemoryStore } from "express-rate-limit";
import { describe, expect, it, vi } from "vitest";
import { configureTrustProxy, parseTrustProxyHops } from "../src/utils/trustProxy.js";

describe("parseTrustProxyHops", () => {
  it("accepts whole numbers from 1 to 5", () => {
    expect(parseTrustProxyHops("1")).toBe(1);
    expect(parseTrustProxyHops(" 2 ")).toBe(2);
    expect(parseTrustProxyHops("5")).toBe(5);
  });

  it.each([undefined, null, "", "  ", "0", "6", "-1", "1.5", "true", "TRUE", "loopback", "1,2", "0x2", "2 hops"])(
    "ignores %j",
    (value) => {
      expect(parseTrustProxyHops(value)).toBeNull();
    }
  );
});

describe("configureTrustProxy", () => {
  it("leaves proxy trust off when unset", () => {
    const app = express();
    expect(configureTrustProxy(app, undefined)).toBeNull();
    expect(app.get("trust proxy")).toBe(false);
  });

  it("never turns on trust-everything, and warns about a bad value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const app = express();
    expect(configureTrustProxy(app, "true")).toBeNull();
    expect(app.get("trust proxy")).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("sets the hop count", () => {
    const app = express();
    expect(configureTrustProxy(app, "2")).toBe(2);
    expect(app.get("trust proxy")).toBe(2);
  });
});

// A one-request limiter keyed on req.ip, like the real login limiter.
const buildApp = (hops) => {
  const app = express();
  configureTrustProxy(app, hops);
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 1,
      store: new MemoryStore(),
      standardHeaders: false,
      legacyHeaders: false,
      validate: false,
    })
  );
  app.get("/", (req, res) => res.json({ ip: req.ip }));
  return app;
};

describe("rate limiting by client IP", () => {
  it("without trust, all visitors share one bucket and X-Forwarded-For is ignored", async () => {
    const app = buildApp(undefined);
    expect((await request(app).get("/").set("X-Forwarded-For", "203.0.113.1")).status).toBe(200);
    expect((await request(app).get("/").set("X-Forwarded-For", "203.0.113.2")).status).toBe(429);
  });

  it("with two trusted hops, different clients get separate buckets", async () => {
    const app = buildApp("2");
    // Chain as the app sees it: client, edge proxy (the socket peer is the second hop).
    const a = await request(app).get("/").set("X-Forwarded-For", "203.0.113.1, 198.51.100.7");
    const b = await request(app).get("/").set("X-Forwarded-For", "203.0.113.2, 198.51.100.7");
    expect(a.status).toBe(200);
    expect(a.body.ip).toBe("203.0.113.1");
    expect(b.status).toBe(200);
    expect(b.body.ip).toBe("203.0.113.2");
  });

  it("a client cannot dodge the limit by sending extra leading X-Forwarded-For entries", async () => {
    const app = buildApp("2");
    const first = await request(app).get("/").set("X-Forwarded-For", "6.6.6.1, 203.0.113.1, 198.51.100.7");
    const second = await request(app).get("/").set("X-Forwarded-For", "6.6.6.2, 203.0.113.1, 198.51.100.7");
    expect(first.status).toBe(200);
    expect(first.body.ip).toBe("203.0.113.1");
    expect(second.status).toBe(429);
  });
});
