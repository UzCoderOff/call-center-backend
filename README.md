# Call Center Backend

Backend for the law firm's call-center recording, monitoring and review
system. Receives call logs + recordings synced from the `call-center-agent`
Android app, and serves a REST API for a web frontend with three roles.

## Stack

Express 5 + Prisma (SQLite) + JWT/cookie auth. Kept deliberately simple —
one clean, typed schema, no dynamic/no-code layer. See the design notes at
the top of `prisma/schema.prisma` for the reasoning, especially around the
`Transcript` / `CallAnalysis` tables and the `customFields` JSON field.

SQLite is fine at this scale (a handful of employees). If this ever needs
to move to Postgres for a bigger CRM, Prisma's schema/migrations port over
with just a `datasource` change — nothing in the application code talks to
the database directly.

## Setup

```bash
npm install
cp .env.example .env
# edit .env: set JWT_SECRET, ADMIN_USERNAME, ADMIN_PASSWORD at minimum

npx prisma generate
npx prisma migrate dev --name init
npm run seed        # creates the first DEVELOPER account from .env

npm run dev          # http://localhost:4000
```

`prisma generate` and `migrate` need real network access (they fetch
Prisma's query engine binary) — run them on your machine or the VPS, not in
a restricted sandbox. `npm install` also needs network access to download
the `ffmpeg-static` binary (used to transcode recordings — see the Calls
API entry for `GET /api/calls/:id/recording` below) for your OS/CPU
architecture.

## Roles

- **DEVELOPER** — full access to every endpoint below, no restrictions. This
  is the "I should be able to change everything from the panel" role; there
  is deliberately no separate raw-database endpoint — full access just means
  no route is off-limits. Only a DEVELOPER can create, deactivate, reset the
  password of, or remove an employee **or** a BOSS account.
- **BOSS** — sees and manages every employee's data (calls, recordings,
  stats). Read-only elsewhere: cannot create/remove an employee or another
  BOSS account, deactivate anyone, rotate a device ID, or reset a password.
- **EMPLOYEE** — scoped to their own record only. Can view and listen to
  their own calls and stats; cannot edit anything.

There's no open registration endpoint anywhere. The first DEVELOPER account
comes from `npm run seed`. Every other account is created by a DEVELOPER
from inside the portal: `POST /api/employees` for an EMPLOYEE (creates the
linked login too, plus the device sync token), `POST /api/users` for a
standalone BOSS login (no device/phone number — a BOSS never syncs call
data from a device). There's no portal path to create another DEVELOPER —
that stays a deliberate `npm run seed`-only action.

## Two separate kinds of auth

- **Portal login** (`/api/auth/...`, and everything under `/api/employees`,
  `/api/calls`, `/api/dashboard`) — username/password → JWT in an `httpOnly`
  cookie. This is a human logging into the web dashboard.
- **Device sync** (`POST /api/calls/sync`) — authenticated by the
  `employeeId` token embedded in the Android app's own payload, not a
  cookie. There's no portal session involved; an unrecognized or missing
  `employeeId` gets a bare `401`. Rotate a leaked token with
  `POST /api/employees/:id/regenerate-device-id` — the old one stops
  working immediately.

## API reference

All portal routes are under `/api`, JSON in/out, session via cookie.

**Auth**
- `POST /api/auth/login` `{ username, password }` → sets session cookie
- `POST /api/auth/logout`
- `GET /api/auth/me`

**Employees** (BOSS, DEVELOPER unless noted)
- `GET /api/employees` — list
- `POST /api/employees` `{ name, phoneNumber, username }` (DEVELOPER only) →
  creates the employee + portal login (role `EMPLOYEE`), returns the device
  `employeeId` and a one-time temporary password **shown only in this
  response** — save them now
- `GET /api/employees/:id` — self if EMPLOYEE, any if BOSS/DEVELOPER
- `PATCH /api/employees/:id` `{ name?, phoneNumber?, active? }` (DEVELOPER
  only) — `active: false` is the soft-delete: locks portal login, keeps
  call history and recordings intact
- `POST /api/employees/:id/regenerate-device-id` (DEVELOPER only) — issues a
  new device token, invalidates the old one
- `POST /api/employees/:id/reset-password` (DEVELOPER only)
- `DELETE /api/employees/:id` (DEVELOPER only) — blocked once the employee
  has call history; deactivate instead

**Users / boss accounts** (DEVELOPER only) — standalone portal logins with
no linked Employee record: no phone number, no device sync token, because a
BOSS never syncs call data directly.
- `GET /api/users?role=BOSS` — list boss accounts
- `POST /api/users` `{ username }` → creates a `BOSS` account, returns a
  one-time temporary password **shown only in this response**
- `PATCH /api/users/:id` `{ active? }`
- `POST /api/users/:id/reset-password`
- `DELETE /api/users/:id`

**Calls** (role-scoped automatically — EMPLOYEE always sees only their own)
- `GET /api/calls?employeeId=&from=&to=&missed=&callType=&hasRecording=&page=&pageSize=` —
  `hasRecording=true|false` filters to calls with/without a recording file
- `GET /api/calls/:id` — includes `transcript`/`analysis` once populated
- `GET /api/calls/:id/recording` — streams the audio, supports HTTP Range
  requests (so an `<audio>` player can seek). If the stored file is in a
  format browsers can't natively play (most notably `.amr`/`.awb` — what
  call-recorder apps like Cube ACR save Android calls as), it's transcoded
  to MP3 on first request via `ffmpeg-static` and the result is cached
  under `storage/recording-cache/`, so this only costs time once per call.
  See the comment at the top of `src/utils/audioTranscode.js`.

**Dashboard**
- `GET /api/dashboard?from=&to=` — EMPLOYEE gets their own totals; BOSS/
  DEVELOPER get company totals plus a per-employee breakdown

**Device sync** (no cookie; `employeeId`-gated)
- `POST /api/calls/sync` — multipart/form-data, matches exactly what
  `SyncWorker.kt` in the Android app already sends: a `payload` JSON part
  plus zero or more `recording` file parts. Dedupes on
  `(employeeId, deviceCallLogId)`, so a retried batch never double-inserts.

## The AI pipeline (near-term, not built yet)

`Transcript` and `CallAnalysis` exist in the schema now, empty. The
intended flow once you're ready to wire it up:

1. A worker picks up `CallLog` rows with a `recordingPath` and no
   `Transcript` row (or one with `status: "pending"`), sends the audio to
   your transcription provider, writes the result back with
   `status: "done"`.
2. A second worker picks up `Transcript` rows with `status: "done"` and no
   `CallAnalysis`, sends the text to an LLM, writes `summary` /
   `whatWentWrong` / `improvementAreas` / `score` back.

Both are plain background scripts/cron jobs against the same Prisma client
— no API changes needed, and `GET /api/calls/:id` already returns both
once they're populated. A daily per-employee report is then just a query
grouping `CallAnalysis` by employee and day; doesn't need its own table.

## Deployment notes

- Put this behind a reverse proxy (nginx/Caddy) terminating HTTPS, and set
  `COOKIE_SECURE=true` once it's actually on HTTPS — the login cookie
  refuses to be sent over plain HTTP otherwise, by design.
- Run it with a process manager (pm2 or a systemd unit) so it restarts on
  crash/reboot.
- `storage/recordings/` will grow — back it up, and keep an eye on disk
  space since audio accumulates indefinitely (no retention/cleanup policy
  is implemented yet; easy to add later once you know what retention you
  actually want). `storage/recording-cache/` (transcoded MP3s, generated
  on demand) is safe to delete any time — it's just a cache and gets
  regenerated from the originals the next time a recording is played.
- `npm audit` currently flags a high-severity issue in `mysql2`, pulled in
  transitively by the `prisma` CLI's multi-database support. It's a
  dev-only dependency (not used at runtime, and this app never talks to
  MySQL) — low real-world risk here, but worth re-checking
  (`npm audit`) after your next `npm install`.

## Not built yet (intentionally out of scope for v1)

- Frontend/admin panel — this is API-only
- AI transcription + review pipeline (schema is ready, see above)
- Recording retention/cleanup policy
