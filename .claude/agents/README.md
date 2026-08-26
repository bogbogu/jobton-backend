# Jobton Backend — Engineering Agent Team

This directory defines the specialized agents for working on the Jobton backend
(`jobton-backend`). It also records what was actually found when the codebase
was inspected, so agents (and future contributors) don't have to rediscover
it. **The codebase is the source of truth** — if something here goes stale,
trust `git log` / the files over this document. Last updated 2026-08-25 —
Jobs and Freelancers were built first to match the (previously mock-only)
Jobton frontend, then Saved Jobs (per-user, persisted), Companies, and
Newsletter subscription were added against a BRD gap-analysis. See
[`../../README.md`](../../README.md) for the full API reference handed off
to the frontend team.

## What Jobton backend actually is today

A small but now functionally complete-for-launch Node.js/Express/MongoDB API:
auth, job listings (with per-user saved jobs), a freelancer directory,
company profiles, and newsletter capture, all live. Still explicitly out of
scope: admin portal, SEO slugs for jobs themselves, analytics, Employer/
Application domain — see the BRD gap analysis referenced in project memory/
conversation history if you need the full list of what's deferred and why.

- **Stack**: Node.js (ESM — `"type": "module"`), Express 5.2.1, Mongoose 9.7.4,
  MongoDB (Atlas, `mongodb+srv://`), bcryptjs, jsonwebtoken, Resend (transactional
  email), validator.js. Test stack: Vitest + Supertest + mongodb-memory-server.
- **Entry point**: [`app.js`](../../app.js) — builds the Express app, applies
  `helmet()`, an allow-listed CORS policy (built from `FRONTEND_URL`),
  `express.json()`, `express.urlencoded()`, validates email env config at
  boot (warns only, does
  not block startup), mounts routes, and exports both `app` (default) and an
  async `startServer()`. The app only auto-listens when run directly
  (`process.argv[1] === currentFilePath`), which is why tests import `app.js`
  via Supertest without opening a real port.
- **Mounted routes**: `/api/auth`, `/api/categories`, `/api/jobs`,
  `/api/freelancers`, `/api/companies`, `/api/newsletter`. Full contract
  (query params, response shapes, what the frontend needs to change to
  consume each) is in [`../../README.md`](../../README.md) — that's the
  document to hand the frontend team, not this one.
- **Domain models**: `User`, `Job`, `Freelancer`, `Company`,
  `NewsletterSubscriber`, `SavedJob` (all under `src/models/`).
  `Job.postedBy` and `Freelancer.user` are optional references to the
  `User` who owns that record — nullable so admin/seed-created records
  without a specific owner remain admin-only to modify. `SavedJob` is a
  `{user, job}` join collection (unique compound index) backing per-user
  bookmarks — deliberately not an array field on `User` or `Job`, to avoid
  unbounded document growth. `Company` is only loosely coupled to `Job`
  (matched by name string, not a foreign key — see the README's Companies
  section for why). Still no Employer or Application model — see "Areas
  likely to need architectural attention" below.
- **Tests**: 71 passing tests, 10 files (`tests/*.test.js`). Run with
  `npm test`.

## Verified architectural findings (read this before proposing changes)

1. **Resolved (2026-08-25): Job and Freelancer domains now exist.**
   `job.controller.js`/`job.middleware.js`/`job.route.js` and their
   Freelancer equivalents are fully implemented and mounted at `/api/jobs`
   and `/api/freelancers` — list/detail/create/update/delete, with
   owner-or-admin authorization enforced via `req.job.postedBy`/
   `req.freelancer.user` (see `requireJobOwner`/`requireFreelancerOwner`).
   The `category.controller.js` aggregation bug below is also fixed. Full
   contract in [`../../README.md`](../../README.md). What's still missing:
   no Employer/Application domain (see below), no persistence for job
   save/bookmark or report (still frontend-only), no seed script.
2. **Resolved (2026-08-25): dead duplicate file removed.** The empty
   `src/controllers/user.model.js` (leftover from an early commit) has been
   deleted — nothing imported it.
2b. **Resolved (2026-08-25): `Job` had no `category` field despite
   `category.controller.js` aggregating on it.** `category` is now a real
   schema field, distinct from `industry` (employer sector vs. role/function
   taxonomy — see the README for the distinction). The categories endpoint
   response shape also changed (now `{ message, categories: [{title,
   jobCount}] }`) — safe to change since the frontend was never actually
   calling it (still 100% local mock in `useCategories.ts` as of this
   writing).
2c. **Resolved (2026-08-25): `protect` middleware now rejects a deleted/
   missing user** instead of setting `req.user = null` and calling `next()`
   anyway — this was a prerequisite for the new ownership-check middleware
   (`requireJobOwner`/`requireFreelancerOwner`), which assumes `req.user` is
   always a real document once `protect` has run.
3. **Resolved (2026-08-25): Password policy is now consistent between
   register and reset.** `registerUser` now calls the same
   `validatePasswordPolicy` (8+ chars, at least one letter and one digit —
   `src/utils/authToken.utils.js:49`) that `resetPassword` already used,
   returning the same `{ message, error: "INVALID_PASSWORD" }` shape. Schema
   `minlength: 6` (`src/models/user.model.js:28`) remains as a floor, not the
   only check.
4. **Resolved (2026-08-25): Inconsistent input casting (NoSQL-injection
   surface) fixed.** `registerUser` and `loginUser` now cast
   `String(email).toLowerCase().trim()` before querying/creating, matching
   `forgotPassword`, `verifyEmail`, and `resendVerificationEmail`. All five
   entry points are consistent. Regression tests in
   `tests/auth.routes.test.js` send `email: { $ne: null }` to both endpoints
   and confirm it's coerced to a harmless literal string rather than
   interpreted as a Mongo query operator.
5. **Resolved (2026-08-25): CORS is no longer wide open.**
   `cors({ origin: true, credentials: true })` in `app.js` was replaced with
   an explicit allow-list built from `FRONTEND_URL` (comma-separated list
   supported). Requests without an `Origin` header (curl, Supertest,
   server-to-server) are unaffected. A disallowed origin gets
   `callback(null, false)` (no CORS headers, request still processed
   server-side per how `cors`/browsers actually enforce this) rather than a
   thrown error — throwing was tried first and produced an uncaught 500 with
   a leaked stack trace, which is exactly the class of bug finding #7 below
   warns about, so the safer non-throwing form was used instead.
6. **Resolved (2026-08-25): Rate limiting added to `/login` and
   `/register`.** New `src/middleware/authRateLimit.middleware.js` (
   `express-rate-limit`, in-memory `MemoryStore` per route) limits to 10
   requests/15min per IP on `/login` and 10 requests/hour per IP on
   `/register`, returning `429 { message, error: "RATE_LIMITED" }`. Still
   in-memory like the pre-existing `resendVerificationThrottle` — resets on
   restart, no shared store across instances. That gap (distributed-safe
   rate limiting) is unchanged and still listed under "Areas likely to need
   architectural attention" below.
7. **Resolved (2026-08-25): `helmet` added** (default config) for standard
   security headers. `express-rate-limit` also now in use (see #6). Still no
   centralized error handler or request logger — every controller still
   repeats its own `try/catch` → `console.error` → generic 500 pattern; see
   #5 above for one concrete case (the CORS origin check) where an
   uncaught-error path was found and fixed opportunistically while wiring
   this up. A general centralized error handler remains unbuilt.
8. **No request-body validation library.** Validation is manual per-field
   truthy checks in controllers. `validator` (the npm package) is only used
   inside `email.service.js` to sanity-check env-configured addresses/URLs,
   not to validate incoming request bodies.
9. **Resolved (2026-08-25): `.env.example` now documents every var actually
   read** (`JWT_SECRET`, `JWT_EXPIRES_IN`, `RESEND_*`, `FRONTEND_URL`), and
   `JWT_EXPIRES_IN` is no longer dead config —
   `src/utils/generateToken.js` now reads it (falling back to `"7d"`).
10. **Good practices already in place — preserve these.** Verification and
    password-reset secrets are generated with `crypto.randomBytes`/`randomInt`
    and only their SHA-256 hashes are persisted (raw values are only ever
    emailed) — the actual token/code values never touch the database. All
    sensitive fields (`password`, `emailVerification*`, `passwordReset*`) are
    `select: false` in the schema. `forgotPassword` and
    `resendVerificationEmail` return identical responses whether or not the
    account exists (no user enumeration) — this is tested. Login is correctly
    blocked for unverified accounts. The new `Job`/`Freelancer` ownership
    checks follow the same pattern established here: verify server-side,
    never trust the frontend's route gating alone (see `/api/freelancers`,
    which enforces auth server-side even though the frontend already gates
    it via `ProtectedRoute`).
11. **API versioning still doesn't exist** — `/api/jobs` and
    `/api/freelancers` were added flat, matching the existing `/api/auth` and
    `/api/categories` convention, on the judgment call that introducing
    versioning now (with a total of 4 mounted route groups and one frontend
    consumer) would be premature relative to the cost of retrofitting it once
    there's an actual second API consumer or a breaking change to ship.
    Revisit this call if either of those happens. Pagination now exists for
    `GET /api/jobs` and `GET /api/freelancers` (page/limit, capped at 50) —
    that gap from before is closed.

## Areas likely to need architectural attention as the product grows

- A real domain model for **Employers/Companies** and **Job Applications**.
  `Job.postedBy`/`Freelancer.user` give basic per-record ownership (any
  authenticated `User` can post a job or a freelancer profile, and only they
  or an `admin` can edit/delete it), but there's still no distinct
  "employer" concept, no in-app apply flow, and no way for an employer to
  manage a roster of their own postings as a group.
- **Role-based access control is still just `user`/`admin`.** Object-level
  ownership checks now exist for `Job` and `Freelancer` (see
  `requireJobOwner`/`requireFreelancerOwner`) — extend this same pattern
  (load the resource, compare an owner reference against `req.user._id`,
  allow `admin` to bypass) to any new ownership-bearing resource rather than
  inventing a new authorization style.
- **API versioning strategy** — see finding #11 above; the call so far has
  been to defer it.
- **Centralized error handling and response conventions** — every controller
  still reimplements the same try/catch/500 pattern (including the new
  `job.controller.js`/`freelancer.controller.js`, for consistency with the
  existing ones); worth extracting once the codebase grows past its current
  handful of controllers.
- **Distributed-safe rate limiting** (e.g. Redis-backed) if this ever runs
  behind more than one instance.
- **Salary is now structured (`salaryMin`/`salaryMax`/`salaryCurrency`/
  `salaryPeriod`) instead of a free-text string**, specifically so
  `HIGHEST_SALARY` sort and (eventually) salary-range filtering can work
  correctly — the frontend's `salaryRangeOptions` constant exists but isn't
  wired to any filter yet. If that gets built, filtering by an NGN-bucketed
  range against jobs priced in USD will need an explicit decision (convert
  at a stored/live exchange rate, or scope range filtering to one currency
  at a time) — don't let it default silently to one behavior.

## The team

| Agent | File | Focus |
|---|---|---|
| Solutions Architect | [`solutions-architect.md`](solutions-architect.md) | Overall architecture, domain boundaries, API versioning, scalability, tradeoffs |
| Backend Engineer | [`backend-engineer.md`](backend-engineer.md) | Routes, controllers, services, models, business logic implementation |
| API Engineer | [`api-engineer.md`](api-engineer.md) | REST design, request/response shape, status codes, pagination/filtering, consistency |
| Security Engineer | [`security-engineer.md`](security-engineer.md) | AuthN/AuthZ, injection, rate limiting, CORS, headers, secrets, OWASP API risks |
| Database Engineer | [`database-engineer.md`](database-engineer.md) | Mongoose schema design, indexes, query performance, data integrity |
| QA / Test Engineer | [`qa-test-engineer.md`](qa-test-engineer.md) | Vitest/Supertest coverage, edge cases, regression, auth/authz test scenarios |
| Code Reviewer | [`code-reviewer.md`](code-reviewer.md) | Final review pass — correctness, security, consistency, maintainability |

## Collaboration flow for a significant backend change

1. **Solutions Architect** evaluates where the change fits architecturally.
2. **Security Engineer** flags authN/authZ/injection/exposure implications.
3. **API Engineer** designs the endpoint/request/response contract.
4. **Database Engineer** designs the schema/index/query implications.
5. **Backend Engineer** implements against the above.
6. **QA / Test Engineer** writes/updates tests for success and failure paths.
7. **Code Reviewer** does the final pass before merge.

Use only the agents a given change actually needs — a one-line validation fix
doesn't need the full chain.
