import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Fake Resend client: no test ever reaches the network. Like the real SDK it
// resolves with { data, error } instead of throwing when the API rejects a message.
const send = vi.fn();
vi.mock("resend", () => ({
  Resend: class {
    emails = { send };
  },
}));

process.env.RESEND_API_KEY = "test_key";
process.env.RESEND_FROM_EMAIL = "Jobton <noreply@example.com>";
process.env.FRONTEND_URL = "https://app.example.com";

const { default: app } = await import("../app.js");
const { default: ContactMessage } = await import("../src/models/contactMessage.model.js");
const { __resetContactRateLimitStores } = await import("../src/middleware/contactRateLimit.middleware.js");
const {
  CONTACT_GLOBAL_PER_HOUR,
  CONTACT_LIMITS,
  CONTACT_RATE_LIMITS,
  CONTACT_RETENTION_DAYS,
  DEFAULT_CONTACT_INBOX,
} = await import("../src/utils/contact.utils.js");

let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await ContactMessage.init();
});

beforeEach(() => {
  send.mockReset();
  send.mockResolvedValue({ data: { id: "email_1" }, error: null });
  delete process.env.CONTACT_INBOX_EMAIL;
  __resetContactRateLimitStores();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await ContactMessage.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

const valid = (overrides = {}) => ({
  name: "Ada Lovelace",
  email: "ada@example.com",
  subject: "Question about posting a job",
  message: "Hello,\nhow do I post a job?",
  reference_code: "",
  ...overrides,
});

const post = (body) => request(app).post("/api/contact").send(body);

let counter = 0;
const uniqueEmail = () => `visitor${(counter += 1)}@example.com`;

describe("POST /api/contact validation", () => {
  it("accepts a valid message", async () => {
    const response = await post(valid());

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ message: "Message received." });
  });

  for (const field of ["name", "email", "subject", "message"]) {
    it(`reports a missing ${field} as a field error`, async () => {
      const body = valid();
      delete body[field];

      const response = await post(body);

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("VALIDATION_ERROR");
      expect(Object.keys(response.body.fields)).toEqual([field]);
      expect(await ContactMessage.countDocuments()).toBe(0);
      expect(send).not.toHaveBeenCalled();
    });

    it(`reports an empty or whitespace-only ${field} as a field error`, async () => {
      const response = await post(valid({ [field]: "   \n\t " }));

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("VALIDATION_ERROR");
      expect(response.body.fields[field]).toBeTruthy();
    });

    for (const [label, value] of [
      ["a number", 42],
      ["an object", { $ne: null }],
      ["an array", ["a"]],
      ["null", null],
      ["a boolean", true],
    ]) {
      it(`rejects ${label} as ${field} with INVALID_INPUT`, async () => {
        const response = await post(valid({ [field]: value }));

        expect(response.status).toBe(400);
        expect(response.body).toEqual({ message: "Invalid request payload.", error: "INVALID_INPUT" });
        expect(await ContactMessage.countDocuments()).toBe(0);
      });
    }
  }

  it("rejects a body that is not an object", async () => {
    const response = await request(app).post("/api/contact").send([valid()]);

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("INVALID_INPUT");
  });

  it("rejects an empty body", async () => {
    const response = await request(app).post("/api/contact");

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("INVALID_INPUT");
  });

  it("rejects values over the limits (limits are inclusive)", async () => {
    const tooLong = {
      name: "n".repeat(CONTACT_LIMITS.nameMax + 1),
      subject: "s".repeat(CONTACT_LIMITS.subjectMax + 1),
      message: "m".repeat(CONTACT_LIMITS.messageMax + 1),
      email: `${"e".repeat(CONTACT_LIMITS.emailMax)}@example.com`,
    };

    const response = await post(valid(tooLong));

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("VALIDATION_ERROR");
    expect(Object.keys(response.body.fields).sort()).toEqual(["email", "message", "name", "subject"]);

    const atLimit = await post(
      valid({
        name: "n".repeat(CONTACT_LIMITS.nameMax),
        subject: "s".repeat(CONTACT_LIMITS.subjectMax),
        message: "m".repeat(CONTACT_LIMITS.messageMax),
      })
    );
    expect(atLimit.status).toBe(201);
  });

  it("rejects an email over 254 characters even when it is otherwise well formed", async () => {
    const local = "a".repeat(60);
    const longEmail = `${local}@${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.${"e".repeat(60)}.com`;
    expect(longEmail.length).toBeGreaterThan(CONTACT_LIMITS.emailMax);

    const response = await post(valid({ email: longEmail }));

    expect(response.status).toBe(400);
    expect(response.body.fields.email).toBeTruthy();
  });

  for (const email of ["not-an-email", "a@b", "a b@example.com", '"a,b"@example.com', "a@example.com, b@example.com"]) {
    it(`rejects the invalid email ${JSON.stringify(email)}`, async () => {
      const response = await post(valid({ email }));

      expect(response.status).toBe(400);
      expect(response.body.fields.email).toBeTruthy();
    });
  }

  it("counts the message length after cleaning, not before", async () => {
    const padded = `${"m".repeat(CONTACT_LIMITS.messageMax - 10)}${"<b></b>".repeat(20)}`;
    expect(padded.length).toBeGreaterThan(CONTACT_LIMITS.messageMax);

    const response = await post(valid({ message: padded }));

    expect(response.status).toBe(201);
  });

  it("does not echo submitted values in a validation error", async () => {
    const canary = "canaryvalue".repeat(10);
    const response = await post(valid({ name: canary + "x".repeat(CONTACT_LIMITS.nameMax), email: `${canary}-bad` }));

    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).not.toContain("canary");
    expect(response.body.message).toBe(`Validation failed. ${Object.values(response.body.fields).join(" ")}`);
  });

  it("does not echo a wrong-typed value either", async () => {
    const response = await post(valid({ name: { canary: "canaryvalue" } }));

    expect(JSON.stringify(response.body)).not.toContain("canary");
  });
});

describe("POST /api/contact cleaning", () => {
  it("removes CR/LF and control characters from name and subject", async () => {
    const response = await post(
      valid({
        name: "Ada\r\nBcc: attacker@example.com",
        subject: "Hi\r\nTo: attacker@example.com\u0000\u0007 there\u2028x",
      })
    );

    expect(response.status).toBe(201);

    const saved = await ContactMessage.findOne().lean();
    expect(saved.name).toBe("Ada Bcc: attacker@example.com");
    expect(saved.subject).toBe("Hi To: attacker@example.com there x");

    const payload = send.mock.calls[0][0];
    expect(payload.subject).not.toMatch(/[\r\n]/);
    expect(payload.subject).toBe("[Jobton contact] Hi To: attacker@example.com there x");
    expect(payload.text.split("\n").slice(0, 2)).toEqual([
      "Name: Ada Bcc: attackerexample.com",
      "Reply-to (unverified): ada@example.com",
    ]);
    expect(payload).not.toHaveProperty("bcc");
    expect(payload).not.toHaveProperty("headers");
  });

  it("collapses whitespace and trims name and subject", async () => {
    await post(valid({ name: "  Ada    \t  Lovelace  ", subject: "  Hello   world " }));

    const saved = await ContactMessage.findOne().lean();
    expect(saved.name).toBe("Ada Lovelace");
    expect(saved.subject).toBe("Hello world");
  });

  it("strips HTML from the message but keeps line breaks", async () => {
    const response = await post(
      valid({ message: 'Hi <script>alert(1)</script>team,\r\nsee <a href="https://evil.example">this</a>\r\n\r\nThanks\u0000' })
    );

    expect(response.status).toBe(201);

    const saved = await ContactMessage.findOne().lean();
    expect(saved.message).not.toMatch(/[<>]/);
    expect(saved.message).toContain("see this");
    expect(saved.message).toBe("Hi alert(1)team,\nsee this\n\nThanks");

    const payload = send.mock.calls[0][0];
    expect(payload.text).toContain(saved.message);
  });

  it("lower-cases the email", async () => {
    await post(valid({ email: "  Ada@Example.COM " }));

    const saved = await ContactMessage.findOne().lean();
    expect(saved.email).toBe("ada@example.com");
    expect(send.mock.calls[0][0].replyTo).toBe("ada@example.com");
  });
});

describe("POST /api/contact honeypot", () => {
  it("answers 201 but saves and sends nothing when reference_code is filled in", async () => {
    const real = await post(valid({ email: uniqueEmail() }));
    const trap = await post(valid({ email: uniqueEmail(), reference_code: "https://spam.example" }));

    expect(trap.status).toBe(201);
    expect(trap.body).toEqual(real.body);
    expect(await ContactMessage.countDocuments()).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not treat a field called website as the trap (browsers autofill that name)", async () => {
    const response = await post(valid({ website: "https://autofilled.example" }));

    expect(response.status).toBe(201);
    expect(await ContactMessage.countDocuments()).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("treats a non-string reference_code as the trap too", async () => {
    const response = await post(valid({ reference_code: { a: 1 } }));

    expect(response.status).toBe(201);
    expect(await ContactMessage.countDocuments()).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("answers the trap with 201 even when the rest of the body is invalid", async () => {
    const response = await post({ reference_code: "x" });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ message: "Message received." });
  });

  it("treats a whitespace-only or missing reference_code as empty", async () => {
    expect((await post(valid({ email: uniqueEmail(), reference_code: "   " }))).status).toBe(201);
    const body = valid({ email: uniqueEmail() });
    delete body.reference_code;
    expect((await post(body)).status).toBe(201);
    expect(await ContactMessage.countDocuments()).toBe(2);
  });

  it("does not count the trap against the per-email limit", async () => {
    const email = uniqueEmail();
    for (let i = 0; i < CONTACT_RATE_LIMITS.perEmail; i += 1) {
      await post(valid({ email, reference_code: "x" }));
    }

    expect((await post(valid({ email }))).status).toBe(201);
  });
});

describe("POST /api/contact saving and email", () => {
  it("saves the message and sends one plain-text email with the right headers", async () => {
    const response = await post(valid());

    expect(response.status).toBe(201);
    expect(JSON.stringify(response.body)).not.toContain(DEFAULT_CONTACT_INBOX);

    const saved = await ContactMessage.findOne().lean();
    expect(saved).toMatchObject({
      name: "Ada Lovelace",
      email: "ada@example.com",
      subject: "Question about posting a job",
      message: "Hello,\nhow do I post a job?",
      emailStatus: "sent",
    });
    expect(saved.createdAt).toBeInstanceOf(Date);

    expect(send).toHaveBeenCalledTimes(1);
    const payload = send.mock.calls[0][0];
    expect(payload).toEqual({
      from: "Jobton <noreply@example.com>",
      to: [DEFAULT_CONTACT_INBOX],
      replyTo: "ada@example.com",
      subject: "[Jobton contact] Question about posting a job",
      text: "Name: Ada Lovelace\nReply-to (unverified): ada@example.com\n\nHello,\nhow do I post a job?",
    });
    expect(payload).not.toHaveProperty("html");
    expect(payload).not.toHaveProperty("bcc");
    expect(payload).not.toHaveProperty("cc");
    // The visitor's address is only ever Reply-To, never the sender.
    expect(payload.from).not.toContain("ada@example.com");
  });

  it("does not store the IP address or user agent", async () => {
    await request(app).post("/api/contact").set("User-Agent", "CanaryAgent/1.0").send(valid());

    const saved = await ContactMessage.findOne().lean();
    expect(Object.keys(saved).sort()).toEqual(["__v", "_id", "createdAt", "email", "emailStatus", "message", "name", "subject"]);
    expect(JSON.stringify(saved)).not.toContain("CanaryAgent");
    expect(Object.keys(ContactMessage.schema.paths)).not.toEqual(expect.arrayContaining(["ip"]));
  });

  it("still answers 201 and records emailStatus failed when Resend rejects the message", async () => {
    send.mockResolvedValueOnce({ data: null, error: { name: "validation_error", statusCode: 403, message: "nope" } });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await post(valid());

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ message: "Message received." });

    const saved = await ContactMessage.findOne().lean();
    expect(saved.emailStatus).toBe("failed");

    // One short line with the id only: no visitor content, no address.
    expect(logged).toHaveBeenCalledTimes(1);
    const line = logged.mock.calls[0].join(" ");
    expect(line).toContain(String(saved._id));
    expect(line).not.toContain("ada@example.com");
    expect(line).not.toContain("Hello");
  });

  it("still answers 201 and records failed when the Resend client throws", async () => {
    send.mockRejectedValueOnce(new Error("network down"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await post(valid());

    expect(response.status).toBe(201);
    expect((await ContactMessage.findOne().lean()).emailStatus).toBe("failed");
  });

  it("records skipped and sends nothing when email sending is not configured", async () => {
    const previous = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;

    try {
      const response = await post(valid());

      expect(response.status).toBe(201);
      expect(send).not.toHaveBeenCalled();
      expect((await ContactMessage.findOne().lean()).emailStatus).toBe("skipped");
    } finally {
      process.env.RESEND_API_KEY = previous;
    }
  });

  it("answers the generic 500 and sends nothing when the message cannot be saved", async () => {
    vi.spyOn(ContactMessage, "create").mockRejectedValueOnce(new Error("db exploded: secret detail"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await post(valid());

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ message: "Internal server error." });
    expect(send).not.toHaveBeenCalled();
  });

  it("saves before sending", async () => {
    let countWhenSending;
    send.mockImplementationOnce(async () => {
      countWhenSending = await ContactMessage.countDocuments({ emailStatus: "failed" });
      return { data: { id: "email_1" }, error: null };
    });

    await post(valid());

    expect(countWhenSending).toBe(1);
  });
});

describe("POST /api/contact recipient", () => {
  it("sends to CONTACT_INBOX_EMAIL when it is a valid address", async () => {
    process.env.CONTACT_INBOX_EMAIL = "  team@example.org ";

    await post(valid());

    expect(send.mock.calls[0][0].to).toEqual(["team@example.org"]);
  });

  for (const invalid of ["not-an-email", "Team <team@example.org>", "a@example.org, b@example.org", "   "]) {
    it(`falls back to the default inbox for ${JSON.stringify(invalid)}`, async () => {
      process.env.CONTACT_INBOX_EMAIL = invalid;

      const response = await post(valid());

      expect(response.status).toBe(201);
      expect(send.mock.calls[0][0].to).toEqual([DEFAULT_CONTACT_INBOX]);
    });
  }

  it("never returns the recipient address", async () => {
    process.env.CONTACT_INBOX_EMAIL = "team@example.org";

    const response = await post(valid());

    expect(JSON.stringify(response.body)).not.toContain("team@example.org");
    expect(JSON.stringify(response.headers)).not.toContain("team@example.org");
  });

  it("is not part of the required email config", async () => {
    const { validateEmailConfig } = await import("../src/utils/email.service.js");

    delete process.env.CONTACT_INBOX_EMAIL;

    expect(validateEmailConfig()).toEqual({ isValid: true, missingVars: [], invalidVars: [] });
  });
});

describe("POST /api/contact rate limits", () => {
  it("allows 5 requests per IP per hour and answers the 6th with 429", async () => {
    for (let i = 0; i < CONTACT_RATE_LIMITS.perIp; i += 1) {
      expect((await post(valid({ email: uniqueEmail() }))).status).toBe(201);
    }

    const response = await post(valid({ email: uniqueEmail() }));

    expect(response.status).toBe(429);
    expect(response.body).toEqual({ message: "Too many attempts. Please try again later.", error: "RATE_LIMITED" });
    expect(await ContactMessage.countDocuments()).toBe(CONTACT_RATE_LIMITS.perIp);
    expect(send).toHaveBeenCalledTimes(CONTACT_RATE_LIMITS.perIp);
  });

  it("counts invalid and honeypot requests against the per-IP limit", async () => {
    await post({});
    await post(valid({ reference_code: "x" }));
    await post({ name: 1 });
    await post({});
    await post({});

    expect((await post(valid())).status).toBe(429);
  });

  it("allows 3 messages per email per hour and answers the 4th with 429", async () => {
    const email = uniqueEmail();

    for (let i = 0; i < CONTACT_RATE_LIMITS.perEmail; i += 1) {
      expect((await post(valid({ email: i === 1 ? email.toUpperCase() : email }))).status).toBe(201);
    }

    const response = await post(valid({ email }));

    expect(response.status).toBe(429);
    expect(response.body.error).toBe("RATE_LIMITED");
    expect(await ContactMessage.countDocuments()).toBe(CONTACT_RATE_LIMITS.perEmail);
    expect(send).toHaveBeenCalledTimes(CONTACT_RATE_LIMITS.perEmail);

    // Another address is unaffected.
    expect((await post(valid({ email: uniqueEmail() }))).status).toBe(201);
  });

  it("starts counting again after the stores are reset", async () => {
    for (let i = 0; i < CONTACT_RATE_LIMITS.perIp; i += 1) {
      await post(valid({ email: uniqueEmail() }));
    }
    expect((await post(valid({ email: uniqueEmail() }))).status).toBe(429);

    __resetContactRateLimitStores();

    expect((await post(valid({ email: uniqueEmail() }))).status).toBe(201);
  });

  it("does not share its bucket with the auth rate limiters", async () => {
    const { __resetAuthRateLimitStores } = await import("../src/middleware/authRateLimit.middleware.js");
    for (let i = 0; i < CONTACT_RATE_LIMITS.perIp; i += 1) {
      await post(valid({ email: uniqueEmail() }));
    }

    __resetAuthRateLimitStores();

    expect((await post(valid({ email: uniqueEmail() }))).status).toBe(429);
  });
});

describe("POST /api/contact transport", () => {
  it("sends Cache-Control: no-store on success, errors and rate limits", async () => {
    const ok = await post(valid());
    const bad = await post({});
    expect(ok.headers["cache-control"]).toBe("no-store");
    expect(bad.headers["cache-control"]).toBe("no-store");

    for (let i = 0; i < CONTACT_RATE_LIMITS.perIp; i += 1) await post({});
    const limited = await post(valid({ email: uniqueEmail() }));
    expect(limited.status).toBe(429);
    expect(limited.headers["cache-control"]).toBe("no-store");
  });

  it("rejects a body over 100kb with 413", async () => {
    const response = await post(valid({ message: "m".repeat(150 * 1024) }));

    expect(response.status).toBe(413);
    expect(response.body.error).toBe("PAYLOAD_TOO_LARGE");
  });

  it("answers malformed JSON with INVALID_JSON", async () => {
    const response = await request(app)
      .post("/api/contact")
      .set("Content-Type", "application/json")
      .send('{"name": ');

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("INVALID_JSON");
  });

  it("only exposes POST", async () => {
    const response = await request(app).get("/api/contact");

    expect(response.status).toBe(404);
  });
});

describe("POST /api/contact email addresses are printable ASCII only", () => {
  const ch = (code) => String.fromCharCode(code);

  const refused = {
    "a right-to-left override in the local part": `a${ch(0x202e)}b@x.com`,
    "a trailing zero-width space": `a@x.com${ch(0x200b)}`,
    "a zero-width space in the local part": `a${ch(0x200b)}b@x.com`,
    "an internationalised domain": `a@ex${ch(0xe4)}mple.com`,
    "a soft hyphen": `a${ch(0xad)}b@x.com`,
    "a non-ASCII local part": `${ch(0xe4)}da@example.com`,
  };

  for (const [label, email] of Object.entries(refused)) {
    it(`refuses ${label} with the generic message`, async () => {
      const response = await post(valid({ email }));

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("VALIDATION_ERROR");
      expect(response.body.fields).toEqual({ email: "Please provide a valid email address." });
      expect(await ContactMessage.countDocuments()).toBe(0);
      expect(send).not.toHaveBeenCalled();
    });
  }

  it("still accepts an ordinary address with plus and dots", async () => {
    const response = await post(valid({ email: "first.last+news@sub.example.com" }));

    expect(response.status).toBe(201);
  });
});

describe("POST /api/contact oversize name and subject", () => {
  it("refuses a name over 20,000 raw characters instead of cutting it", async () => {
    const response = await post(valid({ name: `Ada${" ".repeat(20000)}Lovelace` }));

    expect(response.status).toBe(400);
    expect(response.body.fields).toEqual({ name: `Name must be at most ${CONTACT_LIMITS.nameMax} characters.` });
    expect(await ContactMessage.countDocuments()).toBe(0);
  });

  it("refuses a subject over 20,000 raw characters instead of cutting it", async () => {
    const response = await post(valid({ subject: `Hi${" ".repeat(20000)}there` }));

    expect(response.status).toBe(400);
    expect(response.body.fields).toEqual({
      subject: `Subject must be at most ${CONTACT_LIMITS.subjectMax} characters.`,
    });
  });
});

describe("POST /api/contact email body", () => {
  it("strips <, > and @ from the name in the body only", async () => {
    await post(valid({ name: "Ada <ceo@bank.example>  Boss" }));

    const saved = await ContactMessage.findOne().lean();
    expect(saved.name).toBe("Ada <ceo@bank.example> Boss");

    const lines = send.mock.calls[0][0].text.split("\n");
    expect(lines[0]).toBe("Name: Ada ceobank.example Boss");
    expect(lines[1]).toBe("Reply-to (unverified): ada@example.com");
    expect(lines[2]).toBe("");
    expect(send.mock.calls[0][0].text).not.toMatch(/^From:/m);
  });
});

describe("POST /api/contact global flood cap", () => {
  const seed = (count, createdAt) =>
    ContactMessage.collection.insertMany(
      Array.from({ length: count }, (_, i) => ({
        name: "Seed",
        email: `seed${i}@example.com`,
        subject: "Seed",
        message: "Seed message",
        emailStatus: "sent",
        createdAt,
      }))
    );

  it("uses 60 per hour", () => {
    expect(CONTACT_GLOBAL_PER_HOUR).toBe(60);
  });

  it("still sends while the count is below the cap", async () => {
    await seed(CONTACT_GLOBAL_PER_HOUR - 1, new Date());

    const response = await post(valid());

    expect(response.status).toBe(201);
    expect(send).toHaveBeenCalledTimes(1);
    expect((await ContactMessage.findOne({ email: "ada@example.com" }).lean()).emailStatus).toBe("sent");
  });

  it("saves the message, skips the email and still answers 201 once the cap is reached", async () => {
    await seed(CONTACT_GLOBAL_PER_HOUR, new Date());
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await post(valid());

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ message: "Message received." });
    expect(send).not.toHaveBeenCalled();

    const saved = await ContactMessage.findOne({ email: "ada@example.com" }).lean();
    expect(saved.emailStatus).toBe("skipped");

    // One short line, ids only.
    expect(warned).toHaveBeenCalledTimes(1);
    const line = warned.mock.calls[0].join(" ");
    expect(line).toContain(String(saved._id));
    expect(line).not.toContain("ada@example.com");
    expect(line).not.toContain("Hello");
  });

  it("only counts messages from the last hour", async () => {
    await seed(CONTACT_GLOBAL_PER_HOUR, new Date(Date.now() - 2 * 60 * 60 * 1000));

    const response = await post(valid());

    expect(response.status).toBe(201);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not warn when the cap is not reached", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});

    await post(valid());

    expect(warned).not.toHaveBeenCalled();
  });
});

describe("POST /api/contact 500 logging", () => {
  it("logs only the error name and code, never the error object", async () => {
    const failure = Object.assign(new Error("secret detail ada@example.com"), {
      name: "MongoServerError",
      code: 11000,
    });
    vi.spyOn(ContactMessage, "create").mockRejectedValueOnce(failure);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await post(valid());

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ message: "Internal server error." });
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0]).toHaveLength(1);
    const line = String(logged.mock.calls[0][0]);
    expect(line).toContain("MongoServerError");
    expect(line).toContain("11000");
    expect(line).not.toContain("secret");
    expect(line).not.toContain("ada@example.com");
  });
});

describe("ContactMessage retention", () => {
  it("has a TTL index of 90 days on createdAt", async () => {
    const indexes = await ContactMessage.collection.indexes();
    const ttl = indexes.find((index) => index.key?.createdAt === 1);

    expect(CONTACT_RETENTION_DAYS).toBe(90);
    expect(ttl).toBeTruthy();
    expect(ttl.expireAfterSeconds).toBe(90 * 24 * 60 * 60);
  });
});
