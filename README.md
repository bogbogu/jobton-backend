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
| GET | `/` | — | list, filter/sort/paginate (below) |
| GET | `/:id` | — | single job, `404` if missing/invalid id |
| POST | `/` | required | creates a job owned by the caller |
| PATCH | `/:id` | required | owner or `admin` only, `403` otherwise |
| DELETE | `/:id` | required | owner or `admin` only, `403` otherwise |

**GET `/api/jobs` query params** (all optional):

- `keyword` — matches title, company, or skills (case-insensitive substring)
- `location` — case-insensitive substring match
- `type` — exact match on employment type (`Full-time`, `Part-time`,
  `Contract`, `Internship`, `Temporary`, `Freelance`)
- `industry` — exact match (employer's sector, e.g. `Fintech`)
- `category` — exact match (role/function taxonomy, e.g. `Design` —
  **different from `industry`**; see below)
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
  "domain": "flutterwave.com",
  "logo_url": null,
  "title": "Senior Product Designer",
  "location": "Lagos, Nigeria (Remote)",
  "type": "Full-time",
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
  "postedBy": "665f1c2e9a1b2c3d4e5f6788"
}
```

**Frontend changes needed to consume this:**

- `Job.id` is a **string** (Mongo ObjectId), not `number`. Anywhere the
  frontend currently does `Number(id)` or sorts/compares by numeric `id`
  (`useJobsPageService.ts`'s `sort by id`, `SingleJobDetailPage.tsx`'s
  `jobs.find((j) => j.id === Number(id))`) needs to switch to string
  comparison.
- `posted`/`datePosted` are computed server-side from `createdAt` — the
  frontend doesn't need to format dates itself.
- `applicationLink` is new and not yet used — the `JobDetail.tsx` "Apply Now"
  button currently has no `href`/`onClick` at all; wire it to
  `job.applicationLink` (`target="_blank" rel="noreferrer"`).
- `category` is new — a role/function label (`Design`, `Engineering`,
  `Marketing`, ...) distinct from `industry` (the employer's sector,
  `Fintech`, `Technology`, ...). This is what `/api/categories` groups jobs
  by; `industryOptions` in `fieldsKeyValues.ts` filters on `industry`
  instead. Don't conflate the two when wiring the "browse by category" pages
  vs. the industry filter dropdown on `/jobs`.
- `applicants` is a real schema field but there's no Applications feature
  yet to increment it — every job starts at `0`. `MOST_APPLICANTS` sort will
  do nothing meaningful until that exists; don't be surprised by flat
  results.
- **On write** (`POST`/`PATCH`), salary is structured, not a display string:
  `salaryMin` (required), `salaryMax` (optional), `salaryCurrency`
  (`"NGN" | "USD"`, default `NGN`), `salaryPeriod`
  (`"hour" | "month" | "year"`, default `month`). The API derives the
  display string (`job.salary` in the response) from these — there is no
  `salary` field to send. This also means `HIGHEST_SALARY` sort now actually
  works (it didn't client-side before — `useJobsPageService.ts`'s sort
  switch has no case for it yet).
- `save` (bookmark) and `report` are entirely client-only today
  (`useJobsPageService.ts`'s `savedJobIds`/`reportedJobIds` are local
  `Set`s) — there is no backend support for either. If persistence across
  sessions/devices is wanted, that's new backend work, not something this
  API already does.

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
