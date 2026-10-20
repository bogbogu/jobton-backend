import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// app.js reads API_DOCS_ENABLED once at import time, so every scenario below
// imports a FRESH app instance.
//
// dotenv/config is stubbed so a developer's private .env can never switch the
// docs on (or off) behind the test's back.
vi.mock("dotenv/config", () => ({}));

vi.mock("../src/utils/email.service.js", () => ({
  validateEmailConfig: vi.fn(() => ({ isValid: true, missingVars: [], invalidVars: [] })),
  sendVerificationEmail: vi.fn(),
  sendResetPasswordEmail: vi.fn(),
}));

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];

let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

// Fresh copy of app.js (and everything it imports) with the given flag value.
// mongoose itself is a shared singleton, so previously compiled models must be
// dropped before the models are registered again.
const loadApp = async (flag) => {
  if (flag === undefined) {
    delete process.env.API_DOCS_ENABLED;
  } else {
    process.env.API_DOCS_ENABLED = flag;
  }

  vi.resetModules();
  for (const name of mongoose.modelNames()) {
    mongoose.deleteModel(name);
  }

  const { default: app } = await import("../app.js");
  return app;
};

describe("API docs are off by default", () => {
  for (const [label, flag] of [
    ["unset", undefined],
    ['"false"', "false"],
    ['"TRUE" (only exactly "true" enables it)', "TRUE"],
    ['"1"', "1"],
  ]) {
    it(`returns 404 for /api-docs and /api-docs.json when API_DOCS_ENABLED is ${label}`, async () => {
      const app = await loadApp(flag);

      for (const url of ["/api-docs", "/api-docs/", "/api-docs.json", "/api-docs/swagger-ui-init.js"]) {
        const response = await request(app).get(url);
        expect(response.status, url).toBe(404);
      }
    });
  }
});

describe("API docs enabled (API_DOCS_ENABLED=true)", () => {
  let app;

  beforeAll(async () => {
    app = await loadApp("true");
  });

  afterAll(() => {
    delete process.env.API_DOCS_ENABLED;
  });

  it("serves the spec as JSON at /api-docs.json", async () => {
    const response = await request(app).get("/api-docs.json");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/application\/json/);
    expect(response.body.openapi).toMatch(/^3\./);
    expect(response.body.info.title).toBeTruthy();
    expect(response.body.servers).toEqual([expect.objectContaining({ url: "/" })]);
    expect(response.body.components.securitySchemes.bearerAuth).toMatchObject({
      type: "http",
      scheme: "bearer",
      bearerFormat: "JWT",
    });
  });

  it("serves the Swagger UI page at /api-docs", async () => {
    // The page references its assets relatively (./swagger-ui.css), so
    // swagger-ui-express/serve-static redirect /api-docs to /api-docs/ for
    // browsers; following that single redirect must land on the HTML page.
    const redirect = await request(app).get("/api-docs");
    expect(redirect.status).toBe(301);
    expect(redirect.headers.location).toBe("/api-docs/");

    for (const response of [
      await request(app).get("/api-docs").redirects(1),
      await request(app).get("/api-docs/"),
    ]) {
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toMatch(/text\/html/);
      expect(response.text).toContain("swagger-ui");
    }
  });

  it("serves the UI's init script and static assets, and none of the page's scripts is inline", async () => {
    const page = await request(app).get("/api-docs/");

    // Everything the page loads must be same-origin and external, because the
    // CSP is script-src 'self' (no 'unsafe-inline').
    const scriptTags = [...page.text.matchAll(/<script\b([^>]*)>/gi)].map((match) => match[1]);
    expect(scriptTags.length).toBeGreaterThan(0);
    for (const attributes of scriptTags) {
      expect(attributes, "inline <script> would be blocked by CSP").toMatch(/\bsrc=/i);
    }
    expect(page.text).not.toMatch(/\son[a-z]+\s*=/i); // no inline event handlers

    const assetUrls = [
      ...page.text.matchAll(/(?:src|href)="([^"]+\.(?:js|css|png))"/gi),
    ].map((match) => match[1]);
    expect(assetUrls.some((url) => url.endsWith("swagger-ui-init.js"))).toBe(true);
    expect(assetUrls.some((url) => url.endsWith("swagger-ui-bundle.js"))).toBe(true);
    expect(assetUrls.some((url) => url.endsWith(".css"))).toBe(true);

    for (const assetUrl of assetUrls) {
      expect(assetUrl, "assets must be same-origin").not.toMatch(/^(https?:)?\/\//);
      const resolved = new URL(assetUrl, "http://localhost/api-docs/").pathname;
      expect(resolved.startsWith("/api-docs/")).toBe(true);
      const asset = await request(app).get(resolved);
      expect(asset.status, resolved).toBe(200);
    }
  });

  it("keeps helmet's Content-Security-Policy on /api-docs and does not need it relaxed", async () => {
    const page = await request(app).get("/api-docs/");
    const csp = page.headers["content-security-policy"];

    expect(csp).toBeTruthy();
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
  });

  it("keeps the Content-Security-Policy on normal routes when docs are enabled", async () => {
    const jobs = await request(app).get("/api/jobs");
    expect(jobs.status).toBe(200);
    expect(jobs.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(jobs.headers["content-security-policy"]).toContain("script-src 'self'");

    const spec = await request(app).get("/api-docs.json");
    expect(spec.headers["content-security-policy"]).toBeTruthy();
  });
});

describe("spec vs code", () => {
  let app;
  let spec;
  let mounted; // [{ method, path, auth, guards }]

  // Express 5 does not keep the mount prefix on router layers, so read the
  // `app.use("/prefix", router)` lines from app.js and match each router
  // object by identity against the layers in the real router stack. Anything
  // mounted that this cannot account for fails the test below.
  const readMounts = async () => {
    const source = fs.readFileSync(path.join(rootDir, "app.js"), "utf8");
    const importPaths = new Map();
    for (const match of source.matchAll(/^import (\w+) from "(\.\/src\/routes\/[^"]+)";/gm)) {
      importPaths.set(match[1], match[2]);
    }

    const mounts = [];
    for (const match of source.matchAll(/^\s*app\.use\(\s*"([^"]+)"\s*,\s*(\w+)\s*\)/gm)) {
      const modulePath = importPaths.get(match[2]);
      if (modulePath) {
        const { default: router } = await import(path.join(rootDir, modulePath));
        mounts.push({ prefix: match[1], router });
      }
    }
    return mounts;
  };

  const collectMountedRoutes = async () => {
    const mounts = await readMounts();
    const routes = [];
    const unaccounted = [];

    for (const layer of app.router.stack) {
      if (layer.route) {
        // Routes declared directly on the app (not under /api). Only the root
        // greeting is allowed to be undocumented.
        for (const method of Object.keys(layer.route.methods)) {
          unaccounted.push(`${method.toUpperCase()} ${layer.route.path}`);
        }
        continue;
      }

      const routerStack = layer.handle?.stack;
      if (!routerStack) continue; // plain middleware: helmet, cors, body parsers

      const mount = mounts.find((candidate) => candidate.router === layer.handle);
      if (!mount) {
        unaccounted.push(`router mounted without a readable app.use("/prefix", router) in app.js`);
        continue;
      }

      // Router-level guards, e.g. router.use(protect, requireAdmin).
      const routerGuards = routerStack.filter((entry) => !entry.route).map((entry) => entry.name);

      for (const entry of routerStack) {
        if (!entry.route) continue;

        const guards = [...routerGuards, ...entry.route.stack.map((handler) => handler.name)];
        const auth = guards.includes("protect")
          ? "bearer"
          : guards.includes("optionalAuth")
            ? "optional"
            : "public";

        for (const method of Object.keys(entry.route.methods)) {
          const joined = `${mount.prefix}${entry.route.path === "/" ? "" : entry.route.path}`;
          routes.push({
            method,
            path: joined.replace(/:(\w+)/g, "{$1}"),
            auth,
            guards,
          });
        }
      }
    }

    return { routes, unaccounted };
  };

  const specOperations = () =>
    Object.entries(spec.paths).flatMap(([pathKey, item]) =>
      HTTP_METHODS.filter((method) => item[method]).map((method) => ({
        method,
        path: pathKey,
        op: item[method],
      }))
    );

  beforeAll(async () => {
    // Default configuration: docs disabled, so the stack contains only the API.
    app = await loadApp(undefined);
    ({ default: spec } = await import("../src/docs/openapi.js"));
    mounted = await collectMountedRoutes();
  });

  it("finds every mounted router and no undocumented top-level route", () => {
    expect(mounted.routes.length).toBeGreaterThan(30);
    expect(mounted.unaccounted).toEqual(["GET /"]);
  });

  it("documents every mounted route (method + path)", () => {
    const documented = new Set(specOperations().map(({ method, path: p }) => `${method} ${p}`));
    const missing = mounted.routes
      .map(({ method, path: p }) => `${method} ${p}`)
      .filter((key) => !documented.has(key));

    expect(missing, "routes in the code but not in src/docs/openapi.js").toEqual([]);
  });

  it("does not document routes that do not exist", () => {
    const real = new Set(mounted.routes.map(({ method, path: p }) => `${method} ${p}`));
    const invented = specOperations()
      .map(({ method, path: p }) => `${method} ${p}`)
      .filter((key) => !real.has(key));

    expect(invented, "operations in the spec with no matching route").toEqual([]);
  });

  it("states the same access level as the real middleware chain", () => {
    const problems = [];

    for (const route of mounted.routes) {
      const { op } = specOperations().find(
        (candidate) => candidate.method === route.method && candidate.path === route.path
      );
      const security = op.security;
      const requiresBearer = (security || []).length > 0 && (security || []).every((entry) => "bearerAuth" in entry);
      const optionalBearer = (security || []).some((entry) => Object.keys(entry).length === 0) &&
        (security || []).some((entry) => "bearerAuth" in entry);
      const key = `${route.method} ${route.path}`;

      if (route.auth === "bearer" && !requiresBearer) problems.push(`${key}: code requires login, spec does not`);
      if (route.auth === "optional" && !optionalBearer) problems.push(`${key}: code has optional auth, spec differs`);
      if (route.auth === "public" && (security === undefined || security.length !== 0)) {
        problems.push(`${key}: code is public, spec says otherwise`);
      }

      // Role/ownership guards (requireAdmin, requireJobOwner, ...) all answer 403.
      if (route.guards.some((name) => name.startsWith("require")) && !op.responses[403]) {
        problems.push(`${key}: guarded by a role/owner check but the spec has no 403`);
      }
    }

    expect(problems).toEqual([]);
  });

  it("is a structurally valid OpenAPI 3 document", () => {
    expect(spec.openapi).toMatch(/^3\.0\./);
    expect(spec.info.title).toBeTruthy();
    expect(spec.info.version).toBeTruthy();
    expect(spec.info.description).toMatch(/\/api\/auth\/login/);
    expect(spec.info.description).toMatch(/Authorize/);
    expect(spec.servers).toEqual([expect.objectContaining({ url: "/" })]);
    expect(spec.components.securitySchemes.bearerAuth).toMatchObject({ type: "http", scheme: "bearer" });

    // The spec must survive a JSON round trip (no undefined, functions, cycles).
    expect(JSON.parse(JSON.stringify(spec))).toEqual(spec);

    for (const [pathKey, item] of Object.entries(spec.paths)) {
      expect(pathKey.startsWith("/")).toBe(true);
      const templated = [...pathKey.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);

      for (const method of Object.keys(item)) {
        expect(HTTP_METHODS, `${pathKey}: unexpected key ${method}`).toContain(method);
        const declared = (item[method].parameters || [])
          .filter((parameter) => parameter.in === "path")
          .map((parameter) => parameter.name);
        expect(declared.sort(), `${method} ${pathKey} path parameters`).toEqual([...templated].sort());

        for (const parameter of item[method].parameters || []) {
          if (parameter.in === "path") expect(parameter.required).toBe(true);
        }

        for (const code of Object.keys(item[method].responses)) {
          expect(code).toMatch(/^[1-5]\d\d$/);
        }
      }
    }
  });

  it("resolves every $ref", () => {
    const refs = [];
    const walk = (node) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node && typeof node === "object") {
        for (const [key, value] of Object.entries(node)) {
          if (key === "$ref") refs.push(value);
          else walk(value);
        }
      }
    };
    walk(spec);

    expect(refs.length).toBeGreaterThan(10);

    for (const reference of refs) {
      expect(reference, "only local refs are used").toMatch(/^#\//);
      const target = reference
        .slice(2)
        .split("/")
        .reduce((node, segment) => (node === undefined ? undefined : node[segment]), spec);
      expect(target, `unresolved ${reference}`).toBeDefined();
    }
  });

  it("gives every operation a summary, a tag and a response, and every protected one a security requirement", () => {
    const definedTags = new Set(spec.tags.map((tag) => tag.name));

    for (const { method, path: p, op } of specOperations()) {
      const key = `${method} ${p}`;

      expect(op.summary, `${key} summary`).toBeTruthy();
      expect(op.tags?.length, `${key} tags`).toBeGreaterThan(0);
      for (const tag of op.tags) expect(definedTags.has(tag), `${key} tag ${tag}`).toBe(true);
      expect(Object.keys(op.responses).length, `${key} responses`).toBeGreaterThan(0);
      expect(Array.isArray(op.security), `${key} must state its security (use [] for public)`).toBe(true);

      // A route that requires a token must document the 401 it can produce.
      const optional = op.security.some((entry) => Object.keys(entry).length === 0);
      if (op.security.some((entry) => "bearerAuth" in entry) && !optional) {
        expect(op.responses[401], `${key} requires a token but has no 401`).toBeDefined();
      }
    }

    // Every route that really sits behind protect declares bearerAuth.
    for (const route of mounted.routes.filter(({ auth }) => auth !== "public")) {
      const { op } = specOperations().find(
        (candidate) => candidate.method === route.method && candidate.path === route.path
      );
      expect(
        op.security.some((entry) => "bearerAuth" in entry),
        `${route.method} ${route.path} is protected in the code but declares no bearerAuth`
      ).toBe(true);
    }
  });

  it("documents the real error codes the owner cares about", () => {
    const text = JSON.stringify(spec);

    for (const code of [
      "NOT_PENDING",
      "STALE",
      "MISSING_FIELDS",
      "VALIDATION_ERROR",
      "INVALID_REVIEW_STATUS",
      "DUPLICATE_CHANNEL",
      "INVALID_USERNAME",
      "EMAIL_NOT_VERIFIED",
      "INVALID_PASSWORD",
      "RATE_LIMITED",
    ]) {
      expect(text, code).toContain(`"${code}"`);
    }
  });
});
