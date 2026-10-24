// OpenAPI 3.0.3 description of the Jobton API, written by hand.
//
// It documents what the code actually does (field names, enums, limits and the
// machine-readable `error` codes). When you add or change a route, update this
// file: tests/api-docs.test.js walks the real Express router and fails if a
// mounted route is missing here, or if this file describes a route that does
// not exist.

// ---------------------------------------------------------------------------
// Small builders (keep the spec below readable)
// ---------------------------------------------------------------------------

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });

// OpenAPI 3.0.3: an enum on a nullable schema must list null explicitly.
const nullable = (schema) => ({
  ...schema,
  nullable: true,
  ...(schema.enum ? { enum: [...schema.enum, null] } : {}),
});

const JSON_TYPE = "application/json";

const jsonContent = (schema, example) => ({
  [JSON_TYPE]: example === undefined ? { schema } : { schema, example },
});

const requestBody = (schema, { required = true, example } = {}) => ({
  required,
  content: jsonContent(schema, example),
});

const ok = (description, schema, example) => ({
  description,
  content: jsonContent(schema, example),
});

// Client-error response using the shared Error schema. `examples` is a list of
// [name, message, errorCode?] so every real code is visible in the UI.
const failure = (description, examples) => ({
  description,
  content: {
    [JSON_TYPE]: {
      schema: ref("Error"),
      examples: Object.fromEntries(
        examples.map(([name, message, code]) => [
          name,
          { value: code ? { message, error: code } : { message } },
        ])
      ),
    },
  },
});

const idParam = (name, description) => ({
  name,
  in: "path",
  required: true,
  description,
  schema: { type: "string", pattern: "^[0-9a-fA-F]{24}$", example: "665f1c2e9b1e8a3f4c5d6e7f" },
});

const query = (name, schema, description) => ({
  name,
  in: "query",
  required: false,
  description,
  schema,
});

// page/limit are clamped, never rejected: page < 1 becomes 1, limit is held to 1..50,
// and a non-numeric value falls back to the default.
const pagingParams = (defaultLimit) => [
  query("page", { type: "integer", minimum: 1, default: 1 }, "1-based page number. Invalid values fall back to 1."),
  query(
    "limit",
    { type: "integer", minimum: 1, maximum: 50, default: defaultLimit },
    `Page size, clamped to 1-50 (default ${defaultLimit}). Larger values are silently reduced to 50.`
  ),
];

const SECURITY = {
  public: [],
  // An invalid or expired token on these routes is treated as "anonymous", not an error.
  optional: [{}, { bearerAuth: [] }],
  bearer: [{ bearerAuth: [] }],
};

const UNAUTHORIZED = failure("Missing, invalid or expired token, or the user no longer exists.", [
  ["noToken", "Not authorized. No token provided."],
  ["invalidToken", "Not authorized. Invalid token."],
  ["userGone", "Not authorized. User no longer exists."],
]);

const FORBIDDEN_ADMIN = failure("The token is valid but the user's role is not `admin` (the role is read from the database).", [
  ["notAdmin", "Admin access required."],
]);

const SERVER_ERROR = failure("Unexpected server error. The body only contains a generic `message`.", [
  ["serverError", "Internal server error."],
]);

const RATE_LIMITED = failure("Too many attempts from this IP. Retry later.", [
  ["rateLimited", "Too many attempts. Please try again later.", "RATE_LIMITED"],
]);

// access: "public" | "optional" | "bearer"
const operation = ({
  tag,
  summary,
  description,
  access,
  parameters,
  body,
  responses,
}) => {
  const protectedRoute = access === "bearer";

  return {
    tags: [tag],
    summary,
    description,
    ...(parameters ? { parameters } : {}),
    ...(body ? { requestBody: body } : {}),
    security: SECURITY[access],
    responses: {
      ...responses,
      ...(protectedRoute ? { 401: UNAUTHORIZED } : {}),
      500: SERVER_ERROR,
    },
  };
};

// ---------------------------------------------------------------------------
// Shared enums
// ---------------------------------------------------------------------------

const EMPLOYMENT_TYPES = ["Full Time", "Part Time", "Contract", "Internship", "Temporary", "Freelance"];
const WORK_ARRANGEMENTS = ["On-site", "Remote", "Hybrid"];
const SALARY_CURRENCIES = ["NGN", "USD"];
const SALARY_PERIODS = ["hour", "month", "year"];
const JOB_BADGES = ["featured", "verified", "urgent", "new"];
const REVIEW_STATUSES = ["pending_review", "published", "rejected"];
const LINK_CLASSES = ["ats", "company_domain", "form", "social_or_short", "other_domain", "none"];
const AVAILABILITY = ["Available now", "Available next week", "Limited availability"];
const HANDLE_PLATFORMS = ["LinkedIn", "X", "Instagram", "Portfolio", "WhatsApp"];
const CHANNEL_KINDS = ["board", "authored"];
const JOB_SORTS = ["MOST_RECENT", "OLDEST", "HIGHEST_SALARY", "MOST_APPLICANTS"];

const HTTP_URL = { type: "string", format: "uri", pattern: "^https?://", maxLength: 2048 };

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const jobOutputProperties = {
  id: { type: "string", example: "665f1c2e9b1e8a3f4c5d6e7f" },
  company: nullable({ type: "string" }),
  companySlug: nullable({ type: "string", description: "Slug of the company name; matches `GET /api/companies/{slug}` when a profile exists." }),
  domain: { type: "string", description: "Company hostname, e.g. `flutterwave.com`. Empty string when unset." },
  logo_url: nullable({ type: "string", format: "uri" }),
  title: { type: "string" },
  location: nullable({ type: "string" }),
  type: nullable({ type: "string", enum: EMPLOYMENT_TYPES, description: "The job's employment type." }),
  workArrangement: nullable({ type: "string", enum: WORK_ARRANGEMENTS }),
  salary: {
    type: "string",
    description: "Display string derived from the salary fields, e.g. `₦300,000 – ₦500,000 / month`, or `Not specified`.",
  },
  category: nullable({ type: "string" }),
  status: { type: "array", items: { type: "string", enum: JOB_BADGES }, description: "Badges. Only an admin can set these." },
  skills: { type: "array", items: { type: "string" } },
  posted: { type: "string", description: "Relative date: `Today`, `Yesterday` or `N days ago`." },
  applicants: { type: "integer", minimum: 0, description: "Placeholder counter. Nothing increments it yet, so it is normally 0." },
  datePosted: { type: "string", example: "March 4, 2026" },
  industry: { type: "string" },
  experience: { type: "string" },
  qualification: { type: "string" },
  description: { type: "string" },
  responsibilities: { type: "array", items: { type: "string" } },
  applicationLink: nullable({ ...HTTP_URL }),
  applyEmail: nullable({ type: "string", format: "email", description: "Set on ingested jobs only." }),
  applyPhone: nullable({ type: "string", description: "Normalized phone number (digits, optional leading `+`). Set on ingested jobs only." }),
  source: nullable({
    type: "object",
    description: "Present only on jobs imported from Telegram.",
    properties: {
      kind: { type: "string", enum: ["telegram"] },
      channel: nullable({ type: "string" }),
      url: nullable({ type: "string", format: "uri" }),
    },
  }),
  postedBy: nullable({ type: "string", description: "Id of the user who posted the job; `null` for seeded/ingested jobs (admin-only to modify)." }),
  saved: { type: "boolean", description: "Whether the calling user saved this job. Always `false` for anonymous callers." },
};

const jobWritableProperties = {
  title: { type: "string", maxLength: 200 },
  company: { type: "string", maxLength: 200 },
  domain: { type: "string", maxLength: 253, description: "Plain hostname such as `example.com` (no scheme or path). Empty = unset." },
  logoUrl: { ...HTTP_URL, description: "http(s) URL. Empty = unset." },
  location: { type: "string", maxLength: 200 },
  employmentType: { type: "string", enum: EMPLOYMENT_TYPES },
  workArrangement: nullable({ type: "string", enum: WORK_ARRANGEMENTS }),
  salaryMin: { type: "number", minimum: 0, description: "`0` is accepted; `null`, empty or missing is not." },
  salaryMax: nullable({ type: "number", minimum: 0 }),
  salaryCurrency: { type: "string", enum: SALARY_CURRENCIES, default: "NGN" },
  salaryPeriod: nullable({ type: "string", enum: SALARY_PERIODS, default: "month" }),
  category: { type: "string", maxLength: 100, description: "Role/function, e.g. `Design`. Distinct from `industry`." },
  skills: { type: "array", items: { type: "string", maxLength: 100 } },
  industry: { type: "string", maxLength: 100, description: "Employer sector, e.g. `Fintech`." },
  experience: { type: "string", maxLength: 200 },
  qualification: { type: "string", maxLength: 300 },
  description: { type: "string", maxLength: 10000 },
  responsibilities: { type: "array", items: { type: "string", maxLength: 500 } },
  applicationLink: {
    ...HTTP_URL,
    description:
      "Must be a plain `http://` or `https://` URL to a real host. `javascript:`, `data:`, `mailto:`, protocol-relative URLs, credentials in the URL, IP-address hosts and single-label hosts are rejected.",
  },
};

// Approval `edits` re-use the writable job fields except logoUrl.
const { logoUrl: _logoUrl, ...approvalJobProperties } = jobWritableProperties;

const jobInputExample = {
  title: "Backend Engineer",
  company: "Acme Payments",
  location: "Lagos, Nigeria",
  employmentType: "Full Time",
  workArrangement: "Hybrid",
  salaryMin: 400000,
  salaryMax: 700000,
  salaryCurrency: "NGN",
  salaryPeriod: "month",
  category: "Software Development",
  description: "Build and run our payments APIs.",
  applicationLink: "https://acme.example.com/careers/backend-engineer",
};

const schemas = {
  Error: {
    type: "object",
    required: ["message"],
    properties: {
      message: { type: "string", description: "Human-readable explanation." },
      error: {
        type: "string",
        description:
          "Machine-readable code, present only where the frontend needs to branch on it (e.g. `NOT_PENDING`, `STALE`, `MISSING_FIELDS`, `VALIDATION_ERROR`, `INVALID_REVIEW_STATUS`, `DUPLICATE_CHANNEL`, `INVALID_USERNAME`, `EMAIL_NOT_VERIFIED`, `RATE_LIMITED`). Many simple validation errors only carry `message`.",
      },
    },
  },

  Pagination: {
    type: "object",
    properties: {
      page: { type: "integer", minimum: 1 },
      limit: { type: "integer", minimum: 1, maximum: 50 },
      total: { type: "integer", minimum: 0 },
      totalPages: { type: "integer", minimum: 0 },
    },
  },

  UserSummary: {
    type: "object",
    properties: {
      id: { type: "string" },
      firstName: { type: "string" },
      lastName: { type: "string" },
      email: { type: "string", format: "email" },
      role: { type: "string", enum: ["user", "admin"] },
      isVerified: { type: "boolean" },
    },
  },

  CurrentUser: {
    type: "object",
    description: "The stored user document (password and token fields are never included).",
    properties: {
      _id: { type: "string" },
      firstName: { type: "string" },
      lastName: { type: "string" },
      email: { type: "string", format: "email" },
      role: { type: "string", enum: ["user", "admin"] },
      isVerified: { type: "boolean" },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
      __v: { type: "integer" },
    },
  },

  RegisterRequest: {
    type: "object",
    required: ["firstName", "lastName", "email", "password"],
    properties: {
      firstName: { type: "string" },
      lastName: { type: "string" },
      email: { type: "string", format: "email", description: "Lower-cased and trimmed before use." },
      password: {
        type: "string",
        format: "password",
        minLength: 8,
        description: "At least 8 characters with at least one letter and one number.",
      },
    },
  },

  LoginRequest: {
    type: "object",
    required: ["email", "password"],
    properties: {
      email: { type: "string", format: "email" },
      password: { type: "string", format: "password" },
    },
  },

  Job: {
    type: "object",
    description: "Public job shape. Review/ingestion internals are never included.",
    properties: jobOutputProperties,
  },

  AdminJob: {
    type: "object",
    description:
      "Full admin view of a job: the public fields plus raw values for the review form, review state and ingestion provenance.",
    properties: {
      ...jobOutputProperties,
      source: {
        type: "object",
        description: "Provenance. All fields are `null` for jobs not imported from Telegram.",
        properties: {
          kind: nullable({ type: "string", enum: ["telegram"] }),
          channel: nullable({ type: "string" }),
          messageId: nullable({ type: "integer" }),
          url: nullable({ type: "string", format: "uri" }),
          postedAt: nullable({ type: "string", format: "date-time" }),
        },
      },
      employmentType: nullable({ type: "string", enum: EMPLOYMENT_TYPES }),
      salaryMin: nullable({ type: "number" }),
      salaryMax: nullable({ type: "number" }),
      salaryCurrency: { type: "string", enum: SALARY_CURRENCIES },
      salaryPeriod: nullable({ type: "string", enum: SALARY_PERIODS }),
      reviewStatus: {
        type: "string",
        enum: REVIEW_STATUSES,
        description: "Legacy jobs without a stored status are reported as `published`.",
      },
      review: {
        type: "object",
        properties: {
          reviewedBy: nullable({ type: "string", description: "Admin user id." }),
          reviewedAt: nullable({ type: "string", format: "date-time" }),
          rejectionReason: nullable({ type: "string", maxLength: 500 }),
        },
      },
      extraction: {
        type: "object",
        description: "What the Telegram extractor produced and what code checked. Empty (except `post`) on non-ingested jobs.",
        properties: {
          model: { type: "string" },
          corrections: { type: "array", items: { type: "string" } },
          modelNotes: { type: "array", items: { type: "string" }, description: "The LLM's own commentary. Advisory and untrusted." },
          redFlags: { type: "array", items: { type: "string" } },
          linkClass: { type: "string", enum: LINK_CLASSES },
          missing: { type: "array", items: { type: "string" } },
          droppedFields: { type: "array", items: { type: "string" } },
          post: nullable({ type: "string", description: "Id of the raw Telegram post." }),
        },
      },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: {
        type: "string",
        format: "date-time",
        description: "Send this back as `expectedUpdatedAt` when approving to detect concurrent edits.",
      },
    },
  },

  RawPost: {
    type: "object",
    nullable: true,
    description: "The original Telegram post. `null` when the job has none or it was purged by its 90-day TTL.",
    properties: {
      text: { type: "string" },
      links: {
        type: "array",
        items: {
          type: "object",
          properties: { href: { type: "string" }, label: { type: "string" } },
        },
      },
      hasImage: { type: "boolean" },
      postedAt: nullable({ type: "string", format: "date-time" }),
    },
  },

  JobCreate: {
    type: "object",
    required: ["title", "company", "location", "employmentType", "salaryMin", "category", "description", "applicationLink"],
    description:
      "Fields not listed here (`reviewStatus`, `review`, `source`, `extraction`, `dedupeKey`, `applyEmail`, `applyPhone`, `postedBy`) can never be set through this endpoint; they are ignored.",
    properties: {
      ...jobWritableProperties,
      status: {
        type: "array",
        items: { type: "string", enum: JOB_BADGES },
        description: "Badges. ADMIN ONLY: silently dropped when the caller is not an admin.",
      },
    },
    example: jobInputExample,
  },

  JobUpdate: {
    type: "object",
    description:
      "Any subset of the writable fields. `reviewStatus`, `review`, `source`, `extraction`, `dedupeKey`, `applyEmail`, `applyPhone` and `postedBy` are never updatable here; they are ignored.",
    properties: {
      ...jobWritableProperties,
      status: {
        type: "array",
        items: { type: "string", enum: JOB_BADGES },
        description: "Badges. ADMIN ONLY: ignored when the caller is not an admin.",
      },
    },
    example: { description: "Updated description.", salaryMax: 800000 },
  },

  ApproveRequest: {
    type: "object",
    required: ["expectedUpdatedAt"],
    properties: {
      edits: {
        type: "object",
        description:
          "Corrections applied while publishing. Only the fields below are honoured; anything else (`reviewStatus`, `source`, `extraction`, `review`, `dedupeKey`, `postedBy`, ...) is ignored.",
        properties: {
          ...approvalJobProperties,
          applyEmail: { type: "string", format: "email" },
          applyPhone: { type: "string", description: "Normalized form: digits with an optional leading `+`." },
        },
      },
      status: {
        type: "array",
        items: { type: "string", enum: JOB_BADGES },
        description: "Replaces the job's badges (de-duplicated). Omit to leave them unchanged.",
      },
      expectedUpdatedAt: {
        type: "string",
        format: "date-time",
        description:
          "REQUIRED. The `updatedAt` of the job version the admin reviewed: send the `updatedAt` from `GET /api/admin/jobs/{id}`. Missing or `null` fails with `400 EXPECTED_UPDATED_AT_REQUIRED`. If the job changed since (or the value is not a valid date) the call fails with `409 STALE`.",
      },
    },
    example: { edits: { category: "Software Development" }, status: ["verified"], expectedUpdatedAt: "2026-03-04T10:15:30.000Z" },
  },

  RejectRequest: {
    type: "object",
    properties: {
      reason: { type: "string", maxLength: 500, description: "Optional note stored with the review (HTML stripped)." },
    },
  },

  BulkRejectRequest: {
    type: "object",
    required: ["ids"],
    properties: {
      ids: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: { type: "string", pattern: "^[0-9a-fA-F]{24}$" },
        description: "1 to 100 job ids (duplicates are ignored).",
      },
      reason: { type: "string", maxLength: 500 },
    },
  },

  Company: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      slug: { type: "string", description: "Derived from `name`." },
      domain: { type: "string" },
      logo_url: nullable({ type: "string", format: "uri" }),
      description: { type: "string" },
      website: { type: "string" },
      industry: { type: "string" },
      location: { type: "string" },
    },
  },

  CompanyInput: {
    type: "object",
    properties: {
      name: { type: "string", description: "Unique across companies. Changing it changes the slug." },
      domain: { type: "string", description: "Plain hostname such as `example.com`." },
      logoUrl: { ...HTTP_URL, description: "http(s) URL. Empty = unset." },
      description: { type: "string" },
      website: { ...HTTP_URL, description: "http(s) URL. Empty = unset." },
      industry: { type: "string" },
      location: { type: "string" },
    },
  },

  FreelancerHandle: {
    type: "object",
    required: ["platform", "href"],
    properties: {
      platform: { type: "string", enum: HANDLE_PLATFORMS },
      href: { type: "string" },
    },
  },

  FreelancerProfile: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      role: { type: "string" },
      category: { type: "string" },
      location: { type: "string" },
      availability: { type: "string", enum: AVAILABILITY },
      hourlyRate: { type: "string", description: "Free text, e.g. `$25/hr`." },
      yearsExperience: { type: "number", minimum: 0 },
      projectsCompleted: { type: "number", minimum: 0 },
      rating: { type: "number", minimum: 0, maximum: 5 },
      bio: { type: "string" },
      skills: { type: "array", items: { type: "string" } },
      email: { type: "string" },
      phone: { type: "string" },
      handles: { type: "array", items: ref("FreelancerHandle") },
    },
  },

  FreelancerCreate: {
    type: "object",
    required: ["name", "role", "category", "location", "hourlyRate", "yearsExperience", "bio", "email", "phone"],
    description: "`yearsExperience` may be `0`; the other required fields must be non-empty.",
    properties: {
      name: { type: "string" },
      role: { type: "string" },
      category: { type: "string" },
      location: { type: "string" },
      availability: { type: "string", enum: AVAILABILITY, default: "Available now" },
      hourlyRate: { type: "string" },
      yearsExperience: { type: "number", minimum: 0 },
      projectsCompleted: { type: "number", minimum: 0, default: 0 },
      rating: { type: "number", minimum: 0, maximum: 5, default: 0 },
      bio: { type: "string" },
      skills: { type: "array", items: { type: "string" } },
      email: { type: "string", description: "Lower-cased and trimmed. Not format-validated by the API." },
      phone: { type: "string" },
      handles: { type: "array", items: ref("FreelancerHandle") },
    },
  },

  FreelancerUpdate: {
    type: "object",
    description: "Any subset of the create fields.",
    properties: {
      name: { type: "string" },
      role: { type: "string" },
      category: { type: "string" },
      location: { type: "string" },
      availability: { type: "string", enum: AVAILABILITY },
      hourlyRate: { type: "string" },
      yearsExperience: { type: "number", minimum: 0 },
      projectsCompleted: { type: "number", minimum: 0 },
      rating: { type: "number", minimum: 0, maximum: 5 },
      bio: { type: "string" },
      skills: { type: "array", items: { type: "string" } },
      email: { type: "string" },
      phone: { type: "string" },
      handles: { type: "array", items: ref("FreelancerHandle") },
    },
  },

  JobCounts: {
    type: "object",
    description: "Number of jobs from the channel per review status (legacy jobs count as `published`).",
    properties: {
      pending_review: { type: "integer" },
      published: { type: "integer" },
      rejected: { type: "integer" },
    },
  },

  TelegramChannel: {
    type: "object",
    properties: {
      id: { type: "string" },
      username: { type: "string", description: "Lower-case, 5-32 chars of `a-z 0-9 _`, starting with a letter." },
      kind: { type: "string", enum: CHANNEL_KINDS, description: "`board`: one post is normally one vacancy. `authored`: a post may bundle several." },
      active: { type: "boolean" },
      lastPolledAt: nullable({ type: "string", format: "date-time" }),
      lastMessageId: { type: "integer" },
      consecutiveFailures: { type: "integer" },
      lastError: nullable({ type: "string", maxLength: 300 }),
      addedBy: nullable({ type: "string", description: "Admin user id." }),
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
      jobCounts: ref("JobCounts"),
    },
  },
};

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

const tags = [
  { name: "Auth", description: "Registration, email verification, login and password reset." },
  { name: "Categories", description: "Job categories with counts of published jobs." },
  { name: "Jobs", description: "Public job board plus posting, editing and saving jobs." },
  { name: "Freelancers", description: "Freelancer directory (logged-in users only)." },
  { name: "Companies", description: "Company profiles." },
  { name: "Newsletter", description: "Newsletter subscription." },
  { name: "Admin - Jobs", description: "Review queue: list, inspect, approve and reject jobs. Admin only." },
  { name: "Admin - Telegram channels", description: "Manage the Telegram channels the ingestion job polls. Admin only." },
];

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const jobIdParam = idParam("id", "Job id (24-character hex ObjectId). Anything else returns 404.");

const jobNotFound = failure("No such job, or it is not visible to the caller.", [["notFound", "Job not found."]]);

const paths = {
  // ---- Auth ---------------------------------------------------------------
  "/api/auth/register": {
    post: operation({
      tag: "Auth",
      summary: "Register a new account",
      description:
        "Creates an unverified user and emails a verification token and 6-digit code (both valid for 20 minutes). A failed email send does not fail the request; check `emailStatus`. Rate limited to 10 registrations per IP per hour. New users always get role `user`.",
      access: "public",
      body: requestBody(ref("RegisterRequest")),
      responses: {
        201: ok("User created.", {
          type: "object",
          properties: {
            message: { type: "string" },
            emailStatus: { type: "string", enum: ["sent", "failed"] },
            user: ref("UserSummary"),
          },
        }),
        400: failure("Missing fields, weak password or email already registered.", [
          ["missingFields", "Please fill in all required fields."],
          ["invalidPassword", "Password must be at least 8 characters long.", "INVALID_PASSWORD"],
          ["emailExists", "Email already exists."],
        ]),
        429: RATE_LIMITED,
      },
    }),
  },

  "/api/auth/login": {
    post: operation({
      tag: "Auth",
      summary: "Log in and get a JWT",
      description:
        "Returns a JWT valid for 7 days by default (`JWT_EXPIRES_IN`). Copy `token` and click **Authorize** to use it. The email must be verified. Rate limited to 10 attempts per IP per 15 minutes.",
      access: "public",
      body: requestBody(ref("LoginRequest")),
      responses: {
        200: ok("Logged in.", {
          type: "object",
          properties: {
            message: { type: "string", example: "Login successful." },
            token: { type: "string", description: "JWT. Send as `Authorization: Bearer <token>`." },
            user: ref("UserSummary"),
          },
        }),
        400: failure("Email or password missing.", [["missing", "Please provide email and password."]]),
        401: failure("Unknown email or wrong password (same message for both).", [["invalid", "Invalid email or password."]]),
        403: failure("Credentials are right but the email is not verified yet.", [
          ["unverified", "Email not verified. Please verify your email before logging in.", "EMAIL_NOT_VERIFIED"],
        ]),
        429: RATE_LIMITED,
      },
    }),
  },

  "/api/auth/verify-email": {
    post: operation({
      tag: "Auth",
      summary: "Verify an email address",
      description:
        "Send EITHER `token` (from the emailed link) OR `email` together with `code` (the 6-digit code). Both expire 20 minutes after they are issued.",
      access: "public",
      body: requestBody({
        type: "object",
        properties: {
          token: { type: "string", description: "Verification token from the email link." },
          email: { type: "string", format: "email" },
          code: { type: "string", description: "6-digit code from the email. Use with `email`." },
        },
      }),
      responses: {
        200: ok("Email verified.", {
          type: "object",
          properties: { message: { type: "string", example: "Email verified successfully." } },
        }),
        400: failure("Nothing provided, or the token/code is wrong or expired.", [
          ["missing", "Provide either verification token or email and verification code."],
          ["invalidToken", "Invalid verification token.", "INVALID_TOKEN"],
          ["invalidCode", "Invalid verification code.", "INVALID_CODE"],
          ["expiredToken", "Verification token has expired. Please request a new one.", "EXPIRED_TOKEN"],
          ["expiredCode", "Verification code has expired. Please request a new one.", "EXPIRED_CODE"],
        ]),
        409: failure("The account is already verified.", [["already", "Email is already verified.", "ALREADY_VERIFIED"]]),
      },
    }),
  },

  "/api/auth/resend-verification": {
    post: operation({
      tag: "Auth",
      summary: "Resend the verification email",
      description:
        "Always answers 200 with the same message whether or not the email exists or is already verified (no account enumeration). Throttled to 15 requests per IP per 10 minutes and 5 per email per 30 minutes.",
      access: "public",
      body: requestBody({
        type: "object",
        required: ["email"],
        properties: { email: { type: "string", format: "email" } },
      }),
      responses: {
        200: ok("Generic acknowledgement.", {
          type: "object",
          properties: {
            message: {
              type: "string",
              example: "If that email exists and is not yet verified, a verification email has been sent.",
            },
          },
        }),
        400: failure("Email missing.", [["missing", "Email is required."]]),
        429: failure("Too many resend attempts.", [
          ["rateLimited", "Too many resend attempts. Please try again later.", "RATE_LIMITED"],
        ]),
      },
    }),
  },

  "/api/auth/forgot-password": {
    post: operation({
      tag: "Auth",
      summary: "Request a password reset email",
      description:
        "Always answers 200 with the same message whether or not the email exists. The reset token is valid for 20 minutes and single-use.",
      access: "public",
      body: requestBody({
        type: "object",
        required: ["email"],
        properties: { email: { type: "string", format: "email" } },
      }),
      responses: {
        200: ok("Generic acknowledgement.", {
          type: "object",
          properties: {
            message: { type: "string", example: "If that email exists, password reset instructions have been sent." },
          },
        }),
        400: failure("Email missing.", [["missing", "Email is required."]]),
      },
    }),
  },

  "/api/auth/reset-password": {
    post: operation({
      tag: "Auth",
      summary: "Set a new password using a reset token",
      description: "The password must be at least 8 characters with at least one letter and one number.",
      access: "public",
      body: requestBody({
        type: "object",
        required: ["token", "password"],
        properties: {
          token: { type: "string", description: "Reset token from the email." },
          password: { type: "string", format: "password", minLength: 8 },
        },
      }),
      responses: {
        200: ok("Password changed.", {
          type: "object",
          properties: { message: { type: "string", example: "Password reset successful." } },
        }),
        400: failure("Missing fields, weak password, or a bad reset token.", [
          ["missing", "Token and password are required."],
          ["invalidPassword", "Password must contain at least one letter and one number.", "INVALID_PASSWORD"],
          ["invalidToken", "Invalid reset token.", "INVALID_TOKEN"],
          ["usedToken", "This reset token has already been used.", "USED_TOKEN"],
          ["expiredToken", "Reset token has expired. Please request a new one.", "EXPIRED_TOKEN"],
        ]),
      },
    }),
  },

  "/api/auth/me": {
    get: operation({
      tag: "Auth",
      summary: "Get the logged-in user",
      description: "Returns the user document directly (no `message` wrapper). Handy for checking that your token works.",
      access: "bearer",
      responses: {
        200: ok("The current user.", ref("CurrentUser")),
      },
    }),
  },

  // ---- Categories ---------------------------------------------------------
  "/api/categories": {
    get: operation({
      tag: "Categories",
      summary: "List job categories",
      description: "Categories of PUBLISHED jobs with their counts, most populated first. Public.",
      access: "public",
      responses: {
        200: ok("Categories.", {
          type: "object",
          properties: {
            message: { type: "string" },
            categories: {
              type: "array",
              items: {
                type: "object",
                properties: { title: { type: "string" }, jobCount: { type: "integer" } },
              },
            },
          },
        }),
      },
    }),
  },

  // ---- Jobs ---------------------------------------------------------------
  "/api/jobs": {
    get: operation({
      tag: "Jobs",
      summary: "List published jobs",
      description:
        "Public. Only PUBLISHED jobs are ever returned (pending and rejected jobs are hidden from everyone here, admins included; admins use `/api/admin/jobs`). A bearer token is optional: when valid, each job carries `saved: true/false` for that user; an invalid token is treated as anonymous. Repeated or non-string query parameters are ignored.",
      access: "optional",
      parameters: [
        query("keyword", { type: "string" }, "Case-insensitive substring match on title, company or skills."),
        query("location", { type: "string" }, "Case-insensitive substring match on location."),
        query(
          "type",
          { type: "string", enum: [...EMPLOYMENT_TYPES, ...WORK_ARRANGEMENTS] },
          "Matches either the employment type or the work arrangement. Other values simply match nothing."
        ),
        query("industry", { type: "string" }, "Exact match."),
        query("category", { type: "string" }, "Exact match."),
        query("company", { type: "string" }, "Exact company name."),
        query("sort", { type: "string", enum: JOB_SORTS, default: "MOST_RECENT" }, "Unknown values fall back to `MOST_RECENT`."),
        ...pagingParams(12),
      ],
      responses: {
        200: ok("A page of jobs.", {
          type: "object",
          properties: {
            message: { type: "string", example: "Jobs retrieved successfully." },
            jobs: { type: "array", items: ref("Job") },
            pagination: ref("Pagination"),
          },
        }),
      },
    }),
    post: operation({
      tag: "Jobs",
      summary: "Post a job",
      description:
        "Any logged-in user can post. Non-admin submissions are saved as `pending_review` and are NOT public until an admin approves them (message: `Job submitted for review.`). Admin submissions are published immediately. You become the job's owner (`postedBy`). `status` badges are admin-only and silently dropped for everyone else.",
      access: "bearer",
      body: requestBody(ref("JobCreate")),
      responses: {
        201: ok("Job created (admin) or submitted for review (everyone else).", {
          type: "object",
          properties: {
            message: { type: "string", enum: ["Job created successfully.", "Job submitted for review."] },
            job: ref("Job"),
          },
        }),
        400: failure("Required fields missing, or a field failed validation.", [
          [
            "missingFields",
            "title, company, location, employmentType, salaryMin, category, description, and applicationLink are required.",
          ],
          ["validation", "Job validation failed: applicationLink: applicationLink must be an http(s) URL."],
          ["cast", "Invalid value for salaryMin."],
        ]),
      },
    }),
  },

  "/api/jobs/saved": {
    get: operation({
      tag: "Jobs",
      summary: "List my saved jobs",
      description:
        "Newest save first. Only jobs that are still published are listed and counted, so a job taken down after saving disappears from this list.",
      access: "bearer",
      parameters: pagingParams(12),
      responses: {
        200: ok("A page of saved jobs (each has `saved: true`).", {
          type: "object",
          properties: {
            message: { type: "string", example: "Saved jobs retrieved successfully." },
            jobs: { type: "array", items: ref("Job") },
            pagination: ref("Pagination"),
          },
        }),
      },
    }),
  },

  "/api/jobs/{id}": {
    get: operation({
      tag: "Jobs",
      summary: "Get one job",
      description:
        "Public, bearer optional (adds `saved`). Pending, rejected and unknown jobs all return the same 404, so unpublished jobs are not detectable here (admins can inspect any job via `/api/admin/jobs/{id}`).",
      access: "optional",
      parameters: [jobIdParam],
      responses: {
        200: ok("The job.", {
          type: "object",
          properties: { message: { type: "string", example: "Job retrieved successfully." }, job: ref("Job") },
        }),
        404: jobNotFound,
      },
    }),
    patch: operation({
      tag: "Jobs",
      summary: "Edit a job (owner or admin)",
      description:
        "Allowed for the user who posted the job or an admin. Send only the fields to change. IMPORTANT: when the OWNER (non-admin) edits a job, it goes back to `pending_review` and disappears from the public list until an admin approves it again (even if it was already published); a rejected job stays rejected. Admin edits never change the review state. `status` badges are only applied for admins. A non-owner who cannot see an unpublished job gets 404 rather than 403.",
      access: "bearer",
      parameters: [jobIdParam],
      body: requestBody(ref("JobUpdate")),
      responses: {
        200: ok("Updated job.", {
          type: "object",
          properties: { message: { type: "string", example: "Job updated successfully." }, job: ref("Job") },
        }),
        400: failure("A changed field failed validation.", [
          ["validation", "Job validation failed: applicationLink: applicationLink must be an http(s) URL."],
          ["cast", "Invalid value for salaryMin."],
        ]),
        403: failure("The caller is neither the owner nor an admin (also true for jobs with no owner).", [
          ["notOwner", "You do not have permission to modify this job."],
        ]),
        404: jobNotFound,
      },
    }),
    delete: operation({
      tag: "Jobs",
      summary: "Delete a job (owner or admin)",
      description:
        "Permanent. Allowed for the user who posted the job or an admin. This is also how a published job is taken down.",
      access: "bearer",
      parameters: [jobIdParam],
      responses: {
        200: ok("Deleted.", {
          type: "object",
          properties: { message: { type: "string", example: "Job deleted successfully." } },
        }),
        403: failure("The caller is neither the owner nor an admin.", [
          ["notOwner", "You do not have permission to modify this job."],
        ]),
        404: jobNotFound,
      },
    }),
  },

  "/api/jobs/{id}/save": {
    post: operation({
      tag: "Jobs",
      summary: "Save a job",
      description: "Idempotent. Only published jobs can be saved; anything else is 404.",
      access: "bearer",
      parameters: [jobIdParam],
      responses: {
        200: ok("Saved.", {
          type: "object",
          properties: {
            message: { type: "string", example: "Job saved." },
            saved: { type: "boolean", example: true },
          },
        }),
        404: jobNotFound,
      },
    }),
    delete: operation({
      tag: "Jobs",
      summary: "Unsave a job",
      description:
        "Idempotent. Still works for jobs that are no longer public, so users can clean up old saves. Only 404s when the job does not exist at all.",
      access: "bearer",
      parameters: [jobIdParam],
      responses: {
        200: ok("Removed from saved jobs.", {
          type: "object",
          properties: {
            message: { type: "string", example: "Job removed from saved jobs." },
            saved: { type: "boolean", example: false },
          },
        }),
        404: failure("Invalid id or no such job.", [["notFound", "Job not found."]]),
      },
    }),
  },

  // ---- Freelancers --------------------------------------------------------
  "/api/freelancers": {
    get: operation({
      tag: "Freelancers",
      summary: "List freelancers",
      description: "Every freelancer route requires login (the directory includes contact details). Newest first.",
      access: "bearer",
      parameters: [
        query("q", { type: "string" }, "Case-insensitive substring match on name, role, location or skills."),
        query("category", { type: "string" }, "Exact category. `All` means no filter."),
        ...pagingParams(20),
      ],
      responses: {
        200: ok("A page of freelancers.", {
          type: "object",
          properties: {
            message: { type: "string", example: "Freelancers retrieved successfully." },
            freelancers: { type: "array", items: ref("FreelancerProfile") },
            pagination: ref("Pagination"),
          },
        }),
      },
    }),
    post: operation({
      tag: "Freelancers",
      summary: "Create my freelancer profile",
      description: "The caller becomes the profile's owner. Any logged-in user can create profiles.",
      access: "bearer",
      body: requestBody(ref("FreelancerCreate")),
      responses: {
        201: ok("Profile created.", {
          type: "object",
          properties: {
            message: { type: "string", example: "Freelancer profile created successfully." },
            freelancer: ref("FreelancerProfile"),
          },
        }),
        400: failure("Required fields missing or a field failed validation.", [
          [
            "missingFields",
            "name, role, category, location, hourlyRate, yearsExperience, bio, email, and phone are required.",
          ],
          ["validation", "Freelancer validation failed: rating: Path `rating` (6) is more than maximum allowed value (5)."],
        ]),
      },
    }),
  },

  "/api/freelancers/{id}": {
    get: operation({
      tag: "Freelancers",
      summary: "Get one freelancer",
      access: "bearer",
      parameters: [idParam("id", "Freelancer id (24-character hex ObjectId).")],
      responses: {
        200: ok("The profile.", {
          type: "object",
          properties: {
            message: { type: "string", example: "Freelancer retrieved successfully." },
            freelancer: ref("FreelancerProfile"),
          },
        }),
        404: failure("Invalid id or no such profile.", [["notFound", "Freelancer not found."]]),
      },
    }),
    patch: operation({
      tag: "Freelancers",
      summary: "Edit a freelancer profile (owner or admin)",
      description: "Allowed for the profile's owner or an admin. Profiles with no owner are admin-only. Send only the fields to change.",
      access: "bearer",
      parameters: [idParam("id", "Freelancer id (24-character hex ObjectId).")],
      body: requestBody(ref("FreelancerUpdate")),
      responses: {
        200: ok("Updated profile.", {
          type: "object",
          properties: {
            message: { type: "string", example: "Freelancer profile updated successfully." },
            freelancer: ref("FreelancerProfile"),
          },
        }),
        400: failure("A field failed validation.", [
          ["validation", "Freelancer validation failed: rating: Path `rating` (6) is more than maximum allowed value (5)."],
        ]),
        403: failure("The caller is neither the owner nor an admin.", [
          ["notOwner", "You do not have permission to modify this freelancer profile."],
        ]),
        404: failure("Invalid id or no such profile.", [["notFound", "Freelancer not found."]]),
      },
    }),
    delete: operation({
      tag: "Freelancers",
      summary: "Delete a freelancer profile (owner or admin)",
      access: "bearer",
      parameters: [idParam("id", "Freelancer id (24-character hex ObjectId).")],
      responses: {
        200: ok("Deleted.", {
          type: "object",
          properties: { message: { type: "string", example: "Freelancer profile deleted successfully." } },
        }),
        403: failure("The caller is neither the owner nor an admin.", [
          ["notOwner", "You do not have permission to modify this freelancer profile."],
        ]),
        404: failure("Invalid id or no such profile.", [["notFound", "Freelancer not found."]]),
      },
    }),
  },

  // ---- Companies ----------------------------------------------------------
  "/api/companies": {
    get: operation({
      tag: "Companies",
      summary: "List companies",
      description: "Public. Sorted by name.",
      access: "public",
      parameters: [
        query("keyword", { type: "string" }, "Case-insensitive substring match on the company name."),
        ...pagingParams(20),
      ],
      responses: {
        200: ok("A page of companies.", {
          type: "object",
          properties: {
            message: { type: "string", example: "Companies retrieved successfully." },
            companies: { type: "array", items: ref("Company") },
            pagination: ref("Pagination"),
          },
        }),
      },
    }),
    post: operation({
      tag: "Companies",
      summary: "Create a company profile",
      description: "Any logged-in user can create a company. Editing or deleting it afterwards is admin-only.",
      access: "bearer",
      body: requestBody(ref("CompanyInput")),
      responses: {
        201: ok("Company created.", {
          type: "object",
          properties: {
            message: { type: "string", example: "Company created successfully." },
            company: ref("Company"),
          },
        }),
        400: failure("`name` missing or a field failed validation.", [
          ["missingName", "name is required."],
          ["validation", "Company validation failed: website: website must be an http(s) URL."],
        ]),
        409: failure("A company with this name already exists.", [
          ["duplicate", "A company with this name already exists."],
        ]),
      },
    }),
  },

  "/api/companies/{slug}": {
    get: operation({
      tag: "Companies",
      summary: "Get a company by slug",
      access: "public",
      parameters: [
        {
          name: "slug",
          in: "path",
          required: true,
          description: "Company slug (derived from the name, e.g. `acme-payments`).",
          schema: { type: "string" },
        },
      ],
      responses: {
        200: ok("The company.", {
          type: "object",
          properties: {
            message: { type: "string", example: "Company retrieved successfully." },
            company: ref("Company"),
          },
        }),
        404: failure("No company with this slug.", [["notFound", "Company not found."]]),
      },
    }),
    patch: operation({
      tag: "Companies",
      summary: "Edit a company (admin only)",
      description: "Admin only. The slug is looked up first, so an unknown slug is 404 even for non-admins. Send only the fields to change.",
      access: "bearer",
      parameters: [
        {
          name: "slug",
          in: "path",
          required: true,
          description: "Company slug.",
          schema: { type: "string" },
        },
      ],
      body: requestBody(ref("CompanyInput")),
      responses: {
        200: ok("Updated company.", {
          type: "object",
          properties: {
            message: { type: "string", example: "Company updated successfully." },
            company: ref("Company"),
          },
        }),
        400: failure("A field failed validation.", [
          ["validation", "Company validation failed: website: website must be an http(s) URL."],
        ]),
        403: failure("The caller is not an admin.", [["notAdmin", "Only an admin can modify company profiles."]]),
        404: failure("No company with this slug.", [["notFound", "Company not found."]]),
        409: failure("Another company already uses this name.", [
          ["duplicate", "A company with this name already exists."],
        ]),
      },
    }),
    delete: operation({
      tag: "Companies",
      summary: "Delete a company (admin only)",
      description: "Admin only and permanent.",
      access: "bearer",
      parameters: [
        {
          name: "slug",
          in: "path",
          required: true,
          description: "Company slug.",
          schema: { type: "string" },
        },
      ],
      responses: {
        200: ok("Deleted.", {
          type: "object",
          properties: { message: { type: "string", example: "Company deleted successfully." } },
        }),
        403: failure("The caller is not an admin.", [["notAdmin", "Only an admin can modify company profiles."]]),
        404: failure("No company with this slug.", [["notFound", "Company not found."]]),
      },
    }),
  },

  // ---- Newsletter ---------------------------------------------------------
  "/api/newsletter/subscribe": {
    post: operation({
      tag: "Newsletter",
      summary: "Subscribe to the newsletter",
      description: "Public. Subscribing an address twice is not an error (200).",
      access: "public",
      body: requestBody({
        type: "object",
        required: ["email"],
        properties: { email: { type: "string", format: "email" } },
      }),
      responses: {
        200: ok("Already subscribed.", {
          type: "object",
          properties: { message: { type: "string", example: "You're already subscribed to the newsletter." } },
        }),
        201: ok("Subscribed.", {
          type: "object",
          properties: { message: { type: "string", example: "Subscribed successfully." } },
        }),
        400: failure("Missing or invalid email.", [["invalidEmail", "Please provide a valid email address."]]),
      },
    }),
  },

  // ---- Admin: jobs --------------------------------------------------------
  "/api/admin/jobs": {
    get: operation({
      tag: "Admin - Jobs",
      summary: "List jobs by review status",
      description:
        "Admin only. Defaults to the pending queue. `published` also includes legacy jobs that have no stored review status. Newest first.",
      access: "bearer",
      parameters: [
        query("reviewStatus", { type: "string", enum: REVIEW_STATUSES, default: "pending_review" }, "Which queue to list. Any other value is `400 INVALID_REVIEW_STATUS`."),
        query("channel", { type: "string" }, "Only jobs imported from this Telegram channel username (case-insensitive)."),
        ...pagingParams(20),
      ],
      responses: {
        200: ok("A page of jobs in the admin view.", {
          type: "object",
          properties: {
            message: { type: "string", example: "Jobs retrieved successfully." },
            jobs: { type: "array", items: ref("AdminJob") },
            pagination: ref("Pagination"),
          },
        }),
        400: failure("Unknown reviewStatus.", [
          [
            "invalidStatus",
            "reviewStatus must be one of: pending_review, published, rejected.",
            "INVALID_REVIEW_STATUS",
          ],
        ]),
        403: FORBIDDEN_ADMIN,
      },
    }),
  },

  "/api/admin/jobs/bulk-reject": {
    post: operation({
      tag: "Admin - Jobs",
      summary: "Reject many pending jobs",
      description:
        "Admin only. Rejects every listed job that is currently `pending_review`; ids that are missing or not pending are skipped without error, so `rejected` can be smaller than the number of ids sent.",
      access: "bearer",
      body: requestBody(ref("BulkRejectRequest")),
      responses: {
        200: ok("How many jobs were rejected.", {
          type: "object",
          properties: {
            message: { type: "string", example: "3 job(s) rejected." },
            rejected: { type: "integer", minimum: 0 },
          },
        }),
        400: failure("Bad `ids` or `reason`.", [
          ["invalidIds", "ids must be an array of 1 to 100 job ids.", "INVALID_IDS"],
          ["badId", "ids must all be valid job ids.", "INVALID_IDS"],
          ["invalidReason", "reason must be at most 500 characters.", "INVALID_REASON"],
        ]),
        403: FORBIDDEN_ADMIN,
      },
    }),
  },

  "/api/admin/jobs/{id}": {
    get: operation({
      tag: "Admin - Jobs",
      summary: "Get a job in the admin view",
      description:
        "Admin only. Works for any review status. `rawPost` is the original Telegram post, or `null` if the job has none or it was purged (posts are deleted after 90 days).",
      access: "bearer",
      parameters: [jobIdParam],
      responses: {
        200: ok("The job and its raw source post.", {
          type: "object",
          properties: {
            message: { type: "string", example: "Job retrieved successfully." },
            job: ref("AdminJob"),
            rawPost: ref("RawPost"),
          },
        }),
        403: FORBIDDEN_ADMIN,
        404: jobNotFound,
      },
    }),
  },

  "/api/admin/jobs/{id}/approve": {
    post: operation({
      tag: "Admin - Jobs",
      summary: "Approve and publish a pending job",
      description:
        "Admin only. Optionally corrects fields (`edits`) and sets badges (`status`) in the same call. To publish, the merged job needs title, description, company, location, category and at least one of applicationLink, applyEmail or applyPhone, otherwise `400 MISSING_FIELDS` (`applyContact` in `missing` stands for the three apply fields); any other schema problem is `400 VALIDATION_ERROR` with a per-field `fields` map. The publish is atomic: it only succeeds if the job is still `pending_review` AND has not changed since it was read, so an owner edit made in between can never be published unseen (`409 STALE`). `expectedUpdatedAt` is REQUIRED so an admin can never publish a version they did not look at: send the `updatedAt` from `GET /api/admin/jobs/{id}` (missing or `null` is `400 EXPECTED_UPDATED_AT_REQUIRED`, checked before anything is written); if the job changed after that version, the call is `409 STALE`.",
      access: "bearer",
      parameters: [jobIdParam],
      body: requestBody(ref("ApproveRequest")),
      responses: {
        200: ok("Published job.", {
          type: "object",
          properties: {
            message: { type: "string", example: "Job approved and published." },
            job: ref("AdminJob"),
          },
        }),
        400: {
          description: "Bad request body, or the job cannot be published as it stands.",
          content: {
            [JSON_TYPE]: {
              schema: {
                allOf: [
                  ref("Error"),
                  {
                    type: "object",
                    properties: {
                      missing: {
                        type: "array",
                        items: { type: "string" },
                        description: "Only with `MISSING_FIELDS`.",
                      },
                      fields: {
                        type: "object",
                        additionalProperties: { type: "string" },
                        description: "Only with `VALIDATION_ERROR`: field path to message.",
                      },
                    },
                  },
                ],
              },
              examples: {
                expectedUpdatedAtRequired: {
                  value: {
                    message:
                      "expectedUpdatedAt is required: send the updatedAt of the job version you reviewed.",
                    error: "EXPECTED_UPDATED_AT_REQUIRED",
                  },
                },
                invalidEdits: { value: { message: "edits must be an object.", error: "INVALID_EDITS" } },
                invalidStatus: {
                  value: {
                    message: "status must be an array of: featured, verified, urgent, new.",
                    error: "INVALID_STATUS",
                  },
                },
                missingFields: {
                  value: {
                    message: "Cannot publish: missing category, applyContact.",
                    error: "MISSING_FIELDS",
                    missing: ["category", "applyContact"],
                  },
                },
                validationError: {
                  value: {
                    message: "Validation failed.",
                    error: "VALIDATION_ERROR",
                    fields: { applicationLink: "applicationLink must be an http(s) URL." },
                  },
                },
              },
            },
          },
        },
        403: FORBIDDEN_ADMIN,
        404: jobNotFound,
        409: failure("The job is no longer pending, or it changed after it was loaded.", [
          ["notPending", "Job is not pending review.", "NOT_PENDING"],
          ["stale", "This job changed after you opened it. Reload it and review again.", "STALE"],
        ]),
      },
    }),
  },

  "/api/admin/jobs/{id}/reject": {
    post: operation({
      tag: "Admin - Jobs",
      summary: "Reject a pending job",
      description:
        "Admin only. Only `pending_review` jobs can be rejected. Rejected jobs stay hidden from the public and their owner cannot re-queue them by editing.",
      access: "bearer",
      parameters: [jobIdParam],
      body: requestBody(ref("RejectRequest"), { required: false }),
      responses: {
        200: ok("Rejected job.", {
          type: "object",
          properties: {
            message: { type: "string", example: "Job rejected." },
            job: ref("AdminJob"),
          },
        }),
        400: failure("`reason` is not a string or is too long.", [
          ["notString", "reason must be a string.", "INVALID_REASON"],
          ["tooLong", "reason must be at most 500 characters.", "INVALID_REASON"],
        ]),
        403: FORBIDDEN_ADMIN,
        404: jobNotFound,
        409: failure("The job is not pending review.", [["notPending", "Job is not pending review.", "NOT_PENDING"]]),
      },
    }),
  },

  // ---- Admin: Telegram channels ------------------------------------------
  "/api/admin/telegram-channels": {
    get: operation({
      tag: "Admin - Telegram channels",
      summary: "List Telegram channels",
      description: "Admin only. All channels sorted by username, with poll statistics and per-status job counts.",
      access: "bearer",
      responses: {
        200: ok("All channels.", {
          type: "object",
          properties: {
            message: { type: "string", example: "Channels retrieved successfully." },
            channels: { type: "array", items: ref("TelegramChannel") },
          },
        }),
        403: FORBIDDEN_ADMIN,
      },
    }),
    post: operation({
      tag: "Admin - Telegram channels",
      summary: "Add a Telegram channel",
      description:
        "Admin only. `username` may be given as `@name`, `name`, or a `t.me/name` / `telegram.me/name` link; it is normalized to lower case and must be 5-32 characters of `a-z 0-9 _` starting with a letter.",
      access: "bearer",
      body: requestBody(
        {
          type: "object",
          required: ["username"],
          properties: {
            username: { type: "string", example: "@nigeria_job_board" },
            kind: { type: "string", enum: CHANNEL_KINDS, default: "board" },
          },
        },
        { example: { username: "https://t.me/nigeria_job_board", kind: "board" } }
      ),
      responses: {
        201: ok("Channel added.", {
          type: "object",
          properties: {
            message: { type: "string", example: "Channel added." },
            channel: ref("TelegramChannel"),
          },
        }),
        400: failure("Invalid username or kind.", [
          [
            "invalidUsername",
            "Invalid Telegram username. Use 5-32 letters, digits or underscores, starting with a letter.",
            "INVALID_USERNAME",
          ],
          ["invalidKind", "kind must be one of: board, authored.", "INVALID_KIND"],
        ]),
        403: FORBIDDEN_ADMIN,
        409: failure("The channel already exists.", [
          ["duplicate", "This channel is already added.", "DUPLICATE_CHANNEL"],
        ]),
      },
    }),
  },

  "/api/admin/telegram-channels/{id}": {
    patch: operation({
      tag: "Admin - Telegram channels",
      summary: "Update a Telegram channel",
      description:
        "Admin only. Only `active` and `kind` can change; at least one is required. Re-activating a channel also resets its failure counter and last error. There is no delete: deactivate instead.",
      access: "bearer",
      parameters: [idParam("id", "Channel id (24-character hex ObjectId).")],
      body: requestBody({
        type: "object",
        minProperties: 1,
        properties: {
          active: { type: "boolean" },
          kind: { type: "string", enum: CHANNEL_KINDS },
        },
      }),
      responses: {
        200: ok("Updated channel.", {
          type: "object",
          properties: {
            message: { type: "string", example: "Channel updated." },
            channel: ref("TelegramChannel"),
          },
        }),
        400: failure("Invalid body.", [
          ["invalidActive", "active must be a boolean.", "INVALID_ACTIVE"],
          ["invalidKind", "kind must be one of: board, authored.", "INVALID_KIND"],
          ["noChanges", "Provide active and/or kind.", "NO_CHANGES"],
        ]),
        403: FORBIDDEN_ADMIN,
        404: failure("Invalid id or no such channel.", [["notFound", "Channel not found."]]),
      },
    }),
  },
};

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

const openapi = {
  openapi: "3.0.3",
  info: {
    title: "Jobton API",
    version: "1.0.0",
    description: [
      "Interactive documentation for the Jobton backend. Every request you send from here hits the REAL API of the server you are on, so POST/PATCH/DELETE calls change real data.",
      "",
      "**How to log in**",
      "1. Open `POST /api/auth/login`, click **Try it out**, enter your email and password, then **Execute**.",
      "2. Copy the `token` value from the response (without quotes).",
      "3. Click **Authorize** at the top, paste the token into the `bearerAuth` box and confirm.",
      "4. Padlock endpoints now send `Authorization: Bearer <token>` automatically. The token is valid for 7 days by default, then log in again.",
      "",
      "**Things worth knowing**",
      "- Only *published* jobs are public. A job posted by a non-admin is saved as `pending_review` and stays hidden until an admin approves it in `/api/admin/jobs`.",
      "- When the owner of a published job edits it, it goes back to review.",
      "- Admin endpoints need an account whose role is `admin`; others get `403`.",
      "- Errors look like `{ \"message\": \"...\" }`, with an extra machine-readable `\"error\": \"CODE\"` where the frontend needs to branch on it.",
    ].join("\n"),
  },
  servers: [{ url: "/", description: "This server" }],
  tags,
  paths,
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description: "JWT from `POST /api/auth/login`. Paste only the token; the `Bearer ` prefix is added for you.",
      },
    },
    schemas,
  },
};

export default openapi;
