# jobton-backend

Node.js (ESM) + Express 5 + Mongoose 9 + MongoDB API for Jobton.

## Setup

```bash
npm install
cp .env.example .env   # fill in real values — see .env.example for what's required
npm run dev            # nodemon, http://localhost:3000
npm test                # vitest + supertest + mongodb-memory-server
```

## Architecture

`routes/` → `controllers/` → `models/` (Mongoose), with a thin `utils/` layer
for cross-cutting concerns (tokens, email, response formatting). See
[`.claude/agents/README.md`](.claude/agents/README.md) for the full
architectural notes, known technical debt, and the specialized-agent team
this repo uses for backend engineering work.

## API reference

All responses are JSON with a `message` field. Success responses include the
relevant domain-named key (`user`, `job`, `jobs`, `freelancer`, etc.) rather
than a generic `data` wrapper. Client errors that the frontend needs to
branch on include a machine-readable `error` code alongside `message`.
Protected routes require `Authorization: Bearer <jwt>`.

### Auth — `/api/auth` (unchanged, already wired on the frontend)

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/register` | — | `{firstName, lastName, email, password}` → `201` |
| POST | `/login` | — | `{email, password}` → `{token, user}`. `403 EMAIL_NOT_VERIFIED` if unverified |
| POST | `/verify-email` | — | `{token}` or `{email, code}` |
| POST | `/resend-verification` | — | `{email}`, rate-limited |
| POST | `/forgot-password` | — | `{email}`, always `200` (no enumeration) |
| POST | `/reset-password` | — | `{token, password}` |
| GET | `/me` | required | returns the current user |

### Jobs — `/api/jobs`

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/` | optional | list, filter/sort/paginate (below) |
| GET | `/:id` | optional | single job, `404` if missing/invalid id |
| GET | `/saved` | required | the current user's saved jobs, same shape as `GET /` |
| POST | `/` | required | creates a job owned by the caller |
| POST | `/:id/save` | required | idempotent — save a job for the current user |
| DELETE | `/:id/save` | required | idempotent — unsave |
| PATCH | `/:id` | required | owner or `admin` only, `403` otherwise |
| DELETE | `/:id` | required | owner or `admin` only, `403` otherwise |

"optional" auth means the route works with or without a token, but a valid
token changes the response: `job.saved` reflects whether *that* user has
saved it (always `false` when anonymous). This is what lets a public job
list show correct bookmark state for a logged-in visitor without requiring
login just to browse.

**GET `/api/jobs` query params** (all optional):

- `keyword` — matches title, company, or skills (case-insensitive substring)
- `location` — case-insensitive substring match
- `type` — exact match against **either** `employmentType` (`Full Time`,
  `Part Time`, `Contract`, `Internship`, `Temporary`, `Freelance`) **or**
  `workArrangement` (`On-site`, `Remote`, `Hybrid`) — the frontend's job-type
  filter mixes both into one dropdown, so the API matches either field
  rather than forcing the frontend to know which is which
- `industry` — exact match (employer's sector, e.g. `Fintech`)
- `category` — exact match (role/function taxonomy, e.g. `Design` —
  **different from `industry`**; see below)
- `company` — exact match on company name (used by the company detail page
  to list that company's jobs — see Companies below)
- `sort` — one of `MOST_RECENT` (default), `OLDEST`, `HIGHEST_SALARY`,
  `MOST_APPLICANTS`
- `page`, `limit` — pagination (`limit` capped at 50, default 12)

Response: `{ message, jobs: Job[], pagination: { page, limit, total, totalPages } }`

**Job shape returned by the API** (matches `src/types/job-type.ts` in the
frontend, with the differences called out below):

```json
{
  "id": "665f1c2e9a1b2c3d4e5f6789",
  "company": "Flutterwave",
  "companySlug": "flutterwave",
  "domain": "flutterwave.com",
  "logo_url": null,
  "title": "Senior Product Designer",
  "location": "Lagos, Nigeria",
  "type": "Full Time",
  "workArrangement": "Remote",
  "salary": "₦800,000 / month",
  "category": "Design",
  "status": ["verified"],
  "skills": ["UI/UX", "Figma"],
  "posted": "2 days ago",
  "applicants": 0,
  "datePosted": "May 20, 2026",
  "industry": "Fintech",
  "experience": "3–5 years",
  "qualification": "B.Sc / HND",
  "description": "...",
  "responsibilities": ["..."],
  "applicationLink": "https://flutterwave.com/careers/123",
  "postedBy": "665f1c2e9a1b2c3d4e5f6788",
  "saved": false
}
```

`companySlug` is derived from `company` with the same slug function
`Company.slug` uses (see Companies below) — it lets the frontend link a job
straight to its company page without a separate lookup, even for a company
name that has no `Company` document yet (the slug is just computed from the
string, no DB join).

**Frontend wiring status** (Jobs is now actually wired, not just documented —
`src/hooks/useJobs.ts`, `src/services/jobs.service.ts`,
`src/features/Jobs/services/useJobsPageService.ts` in the `jobton` repo):

- `Job.id` is a **string** (Mongo ObjectId) — `useJobsPageService.ts`,
  `SingleJobDetailPage.tsx`, and `FeaturedJobs.tsx` were updated to compare/
  pass it as a string instead of `Number(id)`.
- `posted`/`datePosted` are computed server-side from `createdAt`.
- `JobDetail.tsx`'s "Apply Now" button is wired to `job.applicationLink`
  (`target="_blank" rel="noreferrer"`).
- `category` is a role/function label (`Design`, `Engineering`, ...),
  distinct from `industry` (employer sector) — not yet surfaced in the UI
  (the categories page is still separately mocked), but the field is there.
- `employmentType` is spelled `"Full Time"`/`"Part Time"` (not
  `"Full-time"`/`"Part-time"`) **specifically to match the frontend's
  existing `jobTypeOptions` wording verbatim** — there is no translation
  layer between the stored enum and what the UI displays/filters by. If you
  ever rename these on the frontend, rename the schema enum to match, not
  the other way around.
- `workArrangement` (`On-site`/`Remote`/`Hybrid`, nullable) is a new field,
  separate from `employmentType` on purpose — the frontend previously
  conflated them into a single `type`/`jobTypeOptions` value. The `type`
  query param transparently matches against either field (see above), so
  the existing filter dropdown's UI/values didn't need to change, only the
  backend's interpretation of them.
- `applicants` is a real schema field but there's no Applications feature
  yet to increment it — every job starts at `0`. `MOST_APPLICANTS` sort will
  do nothing meaningful until that exists; don't be surprised by flat
  results.
- **On write** (`POST`/`PATCH`), salary is structured, not a display string:
  `salaryMin` (required), `salaryMax` (optional), `salaryCurrency`
  (`"NGN" | "USD"`, default `NGN`), `salaryPeriod`
  (`"hour" | "month" | "year"`, default `month`). The API derives the
  display string (`job.salary` in the response) from these — there is no
  `salary` field to send. `HIGHEST_SALARY` sort works server-side now, but
  `useJobsPageService.ts`'s client-side sort switch still has no case for
  it (falls through to the default "most recent" order) — not fixed yet,
  since fixing it means re-fetching with `sort=HIGHEST_SALARY` instead of
  re-sorting client-side, a small behavior change left for later.
- `save` (bookmark) is now backend-persisted, per-user, via
  `POST/DELETE /api/jobs/:id/save` and `GET /api/jobs/saved` (see the table
  above) — wired on the frontend. `report` is still entirely client-only
  (`useJobsPageService.ts`'s `reportedJobIds` is a local `Set<string>`) —
  no backend support for it, out of scope for this pass.

### Freelancers — `/api/freelancers`

**Every route requires `Authorization: Bearer <jwt>`** — this mirrors the
frontend's `ProtectedRoute` gate on `/hire-freelancers*`, but enforced
server-side too (the directory includes contact info, so it shouldn't be
reachable by an unauthenticated client just because the UI hides the link).

| Method | Path | Notes |
|---|---|---|
| GET | `/` | list, filter/paginate (below) |
| GET | `/:id` | single profile, `404` if missing/invalid id |
| POST | `/` | creates a profile owned by the caller |
| PATCH | `/:id` | owner or `admin` only |
| DELETE | `/:id` | owner or `admin` only |

**GET `/api/freelancers` query params:** `q` (matches name/role/location/
skills), `category` (exact match, omit or `"All"` for no filter), `page`,
`limit` (capped at 50, default 20).

Response: `{ message, freelancers: FreelancerProfile[], pagination }`

### Companies — `/api/companies`

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/` | — | list, `?keyword=` filters by name (substring, case-insensitive) |
| GET | `/:slug` | — | single company, `404` if unknown |
| POST | `/` | required | any authenticated user can add a company profile |
| PATCH | `/:slug` | `admin` only | `403` for a non-admin, even the creator |
| DELETE | `/:slug` | `admin` only | same |

`slug` is auto-generated from `name` on create (and regenerated if `name`
changes) — lowercased, non-alphanumeric runs collapsed to a single `-`,
e.g. `"Flutterwave Inc."` → `"flutterwave-inc"`. Creating a company with a
name that already exists returns `409`.

**Company is only loosely coupled to Job** — there is no `companyId`
foreign key on `Job`; a company's job listings are fetched separately via
`GET /api/jobs?company=<exact name>`. This was a deliberate choice to avoid
migrating the 56 already-seeded jobs (which store `company` as a plain
string) onto a foreign key relationship. The practical implication: a job
whose `company` string doesn't exactly match any `Company.name` just won't
show up on a company page — creating the `Job` and the `Company` are
independent actions, nothing enforces them staying in sync.

Response shape: `{ message, company: { id, name, slug, domain, logo_url,
description, website, industry, location } }` (single) or
`{ message, companies: Company[], pagination }` (list).

### Newsletter — `/api/newsletter`

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/subscribe` | — | `{email}` → `201` (new) or `200` (already subscribed) |

Idempotent and intentionally low-friction — no confirmation email, no
unsubscribe flow, no admin list-management endpoint (that's part of the
admin portal, which is out of scope for now). Just a `NewsletterSubscriber`
collection (`email`, unique) being populated for future use.

Shape matches `src/types/freelancer-type.ts` exactly except `id` is a string,
not a number — same frontend change needed as for jobs.

### Categories — `/api/categories`

`GET /` (public) → `{ message, categories: [{ title, jobCount }] }`,
derived from a live aggregation over `Job.category`, sorted by `jobCount`
descending.

**This is a breaking shape change from before** (it used to return a bare
array of `{ title, jobs }` where `jobs` was already a number under a
differently-named key) — safe to change now since the frontend was never
actually calling this endpoint (`useCategories.ts` is still 100% local mock
data with hardcoded `lucide-react` icons and pre-formatted "1,240+ Jobs"
strings). When wiring this up:

- Icons can't come from the API — keep a local `title → icon` lookup table
  on the frontend (the category titles are free text set by whoever creates
  a job, so this lookup needs a sensible fallback icon for unrecognized
  titles).
- `jobCount` is a raw number — format it into the "1,240+ Jobs" display
  string client-side, the same way the mock data does today.

## Review workflow (what changed for existing job endpoints)

Every job has a `reviewStatus`: `pending_review`, `published` or `rejected`.
**Only `published` jobs are visible to the public.** Jobs created before this
workflow have no `reviewStatus` at all and count as published (no migration
needed). The rule lives in one place, `src/utils/jobVisibility.js`, and is
applied to the job list, detail, categories, `?company=`, `/saved`, saving and
`loadJob`. A hidden job returns the same `404` as a job that does not exist.

Behaviour changes for existing consumers:

- `POST /api/jobs` by a non-admin returns `201` with `"Job submitted for
  review."` and the job stays hidden until an admin approves it. Admin-created
  jobs are published immediately.
- `PATCH /api/jobs/:id` by the owner (non-admin) of a published job sends it
  back to `pending_review`. Admin edits never change the status. A rejected
  job stays rejected.
- `status` badges (`featured`, `verified`, `urgent`, `new`) are admin-only;
  they are silently dropped from non-admin requests. `reviewStatus`, `review`,
  `source`, `extraction`, `dedupeKey`, `applyEmail`, `applyPhone` and
  `postedBy` can never be set through these endpoints.
- `applicationLink`, `logoUrl` and company `website` / `logoUrl` must be
  `http(s)` URLs (no `javascript:`, `data:`, credentials, IP-literal or
  single-label hosts). `domain` must be a hostname. Text fields are stripped
  of HTML tags and control / bidi characters and have length limits.
- Public job objects gain `applyEmail`, `applyPhone` (both `null` when absent)
  and `source` (`{ kind, channel, url }` for ingested jobs, otherwise `null`).
  `type`, `applicationLink`, `company`, `location` and `category` can be
  `null` on incomplete jobs (published jobs always have company, location and
  category); `salary` is `"Not specified"` when no pay is stated.
- `GET /api/jobs/saved` counts and pages only visible jobs.
- Invalid or repeated query params (`?industry=a&industry=b`) are ignored
  instead of causing a `500`.

## Admin API — `/api/admin`

All routes require `Authorization: Bearer <jwt>` of a user with `role: "admin"`
(`401` without a token, `403` for other users).

| Method | Path | Notes |
|---|---|---|
| GET | `/jobs` | `?reviewStatus=pending_review`, `published` or `rejected` (default `pending_review`; other values `400 INVALID_REVIEW_STATUS`), `?channel=`, `page`, `limit` (max 50). `published` includes legacy jobs. |
| GET | `/jobs/:id` | Full admin view (`reviewStatus`, `review`, `source`, `extraction`, apply fields) plus `rawPost` (the original Telegram text; `null` once purged after 90 days). |
| POST | `/jobs/:id/approve` | Body `{ edits?, status?, expectedUpdatedAt? }`. `edits` may only contain: title, company, domain, location, employmentType, workArrangement, salaryMin, salaryMax, salaryCurrency, salaryPeriod, category, skills, industry, experience, qualification, description, responsibilities, applicationLink, applyEmail, applyPhone. `status` sets the badges (e.g. `["verified"]`). To publish, the merged job needs title, description, company, location, category and at least one of applicationLink / applyEmail / applyPhone, otherwise `400 MISSING_FIELDS` with `missing: [...]` (`applyContact` stands for the three apply fields). Other schema problems: `400 VALIDATION_ERROR` with `fields`. Atomic: `409 NOT_PENDING` if the job is no longer pending, `409 STALE` if it changed after the admin loaded it (send the `updatedAt` you reviewed as `expectedUpdatedAt`). |
| POST | `/jobs/:id/reject` | Body `{ reason? }` (max 500 chars). `409 NOT_PENDING` if not pending. |
| POST | `/jobs/bulk-reject` | Body `{ ids: [1..100 ids], reason? }` → `{ rejected: n }`; only pending jobs are rejected. |
| GET | `/telegram-channels` | Channels with poll stats and `jobCounts` per review status. |
| POST | `/telegram-channels` | Body `{ username, kind? }` (`@name`, `name` or a `t.me/name` link; 5–32 chars `a-z 0-9 _`, starting with a letter). `kind`: `board` (one post ≈ one vacancy) or `authored` (a post may bundle several). `409 DUPLICATE_CHANNEL`. |
| PATCH | `/telegram-channels/:id` | Only `active` and `kind`. Re-activating also resets the failure counter. There is no delete — deactivate instead. |

There is no un-publish endpoint yet: a published job is taken down with
`DELETE /api/jobs/:id`. Approve/reject/bulk actions log one audit line with
ids only (`[admin-audit] action=... admin=... job=...`).

## Telegram ingestion

Jobs are pulled from **public** Telegram channels through their web preview
(`https://t.me/s/<channel>`) — no bot and no admin rights in the channel.
Private channels/groups are not supported by this pipeline.

Flow (`src/services/ingestion`): fetch recent pages (fixed host, strict
username check, 10 s timeout, 2 MB cap, no redirects) → parse with cheerio →
store each post once (`TelegramPost`, raw text deleted after 90 days) → skip
reposts by content hash → extract with Claude (structured output) → **validate
every model value in code** (links, emails and phones must literally appear in
the post; tracking parameters stripped; red flags and link class are computed in
code, never taken from the model) → de-duplicate (title + company + location) →
save as a `pending_review` job. Nothing is published automatically; an admin
approves or rejects (see the Admin API).

Run it once (cron-style, then exit):

```bash
npm run ingest
```

On Render, create a **Cron Job** that runs `npm run ingest` on the schedule you
choose. It has no public endpoint. Overlapping runs are prevented by a lease
in MongoDB. Exit code `1` means the run aborted (bad key / outage / every
channel failing / lost lease) so the scheduler can alert.

Environment variables (see `.env.example`; **never commit real values**):

| Variable | Default | Meaning |
|---|---|---|
| `INGESTION_ENABLED` | `false` | Master switch; the script exits 0 doing nothing unless `true`. |
| `ANTHROPIC_API_KEY` | — | Required when enabled. Set it in Render's environment, never in git. |
| `INGESTION_MODEL` | `claude-haiku-5-5` | Extraction model. |
| `INGESTION_DAILY_LLM_CAP` | `300` | Max LLM calls per UTC day (atomic). A set-but-invalid value counts as `0`. |
| `INGESTION_MAX_POSTS_PER_CHANNEL_RUN` | `40` | Posts processed per channel per run. |
| `INGESTION_MAX_PAGES_PER_CHANNEL` | `3` | Preview pages fetched per channel per run. |
| `INGESTION_MAX_PENDING_PER_CHANNEL` | `200` | A channel with this many pending jobs is paused until reviewed. |
| `INGESTION_FETCH_DELAY_MS` | `2000` | Pause between requests to t.me. |

Operational notes:

- A transient LLM failure (429 / 5xx / network) leaves the post `new` and is
  retried on the next run (up to 5 attempts); five failures in a row abort the run.
- The unique index on `dedupeKey` (`dedupeKey_unique_partial`) fails to build if
  the database already holds duplicate keys; the pipeline then falls back to a
  lookup-only duplicate check and logs it. Check before deploying to a database
  that already ran an earlier version.
- Edits validate only the modified fields, so old job documents that predate
  the newer rules can still be edited.
- Contact details in posts are personal data (Nigeria NDPR): raw posts are
  purged after 90 days; consider a retention policy for rejected jobs.
- The extracted `description`, `title`, `corrections`, `extraction.modelNotes`
  and `rawPost` come from untrusted text: any admin UI must render them as
  **plain text**, never as HTML.

## API documentation (Swagger)

An interactive OpenAPI 3 description of every endpoint (Swagger UI), so you can browse and call the API from a browser instead of Postman. It is **off by default**.

- Turn it on by setting `API_DOCS_ENABLED=true` (exactly `true`; read once at start-up, so restart after changing it). When it is anything else, `/api-docs` and `/api-docs.json` do not exist and return the normal 404.
- UI: `/api-docs` (redirects to `/api-docs/`). Raw spec: `/api-docs.json`.
- Recommended **off on the public live API** (it lists every endpoint, and "Try it out" sends real requests); use it locally or on a private/staging server, or protect it before enabling it publicly.
- The spec is written by hand in `src/docs/openapi.js`. `tests/api-docs.test.js` fails if a mounted route is missing from it or it documents a route that does not exist, so update it whenever you add or change a route.

To call protected endpoints:

1. Log in: open `POST /api/auth/login`, click **Try it out**, enter email and password, **Execute**.
2. Copy the `token` from the response.
3. Click **Authorize** (top right), paste the token (without `Bearer`) and confirm.
4. **Try it out** on any padlock endpoint; the token is sent automatically (it lasts 7 days by default). Admin endpoints need an account with role `admin`.

## Known gaps intentionally not built yet

- No Employer/Company account concept — `postedBy` on `Job` and `user` on
  `Freelancer` just point at whichever authenticated `User` created the
  record. There's no "employer" role distinct from a regular user.
- No Applications domain — "Apply Now" only has a static `applicationLink`
  to send the candidate to (usually an external ATS), not an in-app apply
  flow; `applicants` doesn't move.
- No job save/bookmark or report persistence (see above).
- No seed script — the database starts empty; use `POST /api/jobs` and
  `POST /api/freelancers` (as an authenticated user) to add data, or write a
  one-off seed script if bulk test data is needed.
