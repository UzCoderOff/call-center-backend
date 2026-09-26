# Call Center Backend

The server behind the firm's staff system ("Ledger"): portal logins, staff and
offices, daily reports, and call recording/monitoring for call-center staff.
Serves a REST API to the portal (`call-center-portal`) and to the Android app
(`call-center-agent`).

**Deploying or updating? See [DEPLOY.md](DEPLOY.md).**

## Stack

Express 5 + Prisma (SQLite) + JWT/cookie auth. SQLite is fine at this scale; a
move to Postgres is a `datasource` change in `prisma/schema.prisma` — no
application code talks to the database directly. Read the design notes at the
top of `prisma/schema.prisma` before changing the schema.

## Setup (development)

```bash
npm install
cp .env.example .env         # set JWT_SECRET, ADMIN_USERNAME, ADMIN_PASSWORD at minimum
npx prisma migrate deploy    # creates the database
npm run seed                 # creates the first DEVELOPER account from .env
npm run dev                  # http://localhost:4000
```

Optional demo data (never in production — the script refuses):

```bash
DEMO_PASSWORD=some-password npm run seed:demo
```

It creates offices, positions, three report forms, six staff (three
call-center, three office staff), ~30 days of calls and ~10 days of reports.

`npm test` runs the unit tests (Node's built-in test runner, Node 21+).

## Who can do what

| | Employee | Boss | Developer |
|---|---|---|---|
| Own stats, calls (if collected), reports | ✓ | ✓ everyone's | ✓ everyone's |
| Review reports | — | ✓ | ✓ |
| See staff, settings | — | read-only | ✓ edit |
| Create/remove accounts, reset passwords, sign out phones | — | — | ✓ |

There is no open registration. The first DEVELOPER comes from `npm run seed`;
every other account is created by a DEVELOPER in the portal.

## How staff are modelled

Everything about a person's job is configuration, not code:

- **Office** — where they work (by the court, the translation office…).
- **Position** — a preset (call-center operator, translator…) that pre-fills
  the two settings below when an account is created.
- **Collect calls** — per person. Only when on does the Android app ask for
  call-log/storage permissions and sync that phone's calls. Everyone else's
  phone is never touched.
- **Report form** — the daily report they fill in. Forms are built in the
  portal (Settings → Report forms): questions of type text, long text,
  number, amount (soʻm), yes/no, one choice, several choices. Each submitted
  report stores the questions as they were, so editing a form never changes
  old reports. See `src/services/reportFields.js`.

## The lawyer's calendar

A BOSS account can keep a calendar (Team → Boss accounts → "Keeps a
calendar"). Its settings are the lawyer's **usual week** — working days,
reception hours, a lunch break (12:00–13:00 by default; can be moved or
switched off) and the appointment length. Every new week starts filled in
from it; the lawyer changes any single day — a normal day, **busy all day**
(court in another city, a trip; the reason is shown to staff), a day off, or
their own times (reception / busy / break) — and **confirms** the week.
Only confirmed weeks are visible to staff; untouched weeks follow the
settings as they change, saved or confirmed ones keep their plan.

Staff with calendar access "book" (a per-person setting, preset by
position) book clients into free times; bookings are immediate and
double-booking is impossible. The week view also offers the **nearest free
time** across the coming weeks. Appointments booked from a call are linked
to it, and a call's page shows upcoming appointments with that caller.

When the lawyer changes a day that already has bookings (a sudden court
day), they first see who is booked; confirming cancels those appointments
and asks each person who booked one — on their home page — to tell the
client ("I told them", or re-booking the client, clears it). The lawyer
marks appointments attended / no-show; whoever booked one can cancel it
before it happens. From Thursday the lawyer's home page reminds them to
confirm next week. Logic: `src/services/calendar.js`.

## Authentication

- **Portal (browser):** username/password → JWT in an `httpOnly` session
  cookie. The portal reaches the API through its own domain's `/api` proxy,
  so the cookie is first-party (phone browsers drop third-party cookies).
- **Android app:** `POST /api/device/login` with the person's username and
  password returns a random **device token** (only its hash is stored). The
  app uses it for call sync and to get fresh portal sessions
  (`POST /api/device/session`) — the password is never stored on the phone.
  A DEVELOPER can sign out any phone from the person's page.
- **Legacy agent:** the old manually-configured app authenticates with the
  employee's legacy device ID in the upload payload. Still accepted.

Login is throttled: 8 wrong passwords for one username from one address in
15 minutes → HTTP 429 for the rest of the window.

## Missed-call follow-up

Every missed call gets a follow-up status, recomputed whenever calls with the
same number arrive from any employee's phone (`src/services/followUp.js`):
`called_back` (someone called back and it connected), `client_called_again`
(the caller rang again and was answered), `attempted` (called back, no
answer), `pending`, `handled` (marked in the portal — reached another way),
`no_number` (hidden number). Numbers are matched by their last 9 digits
(`src/lib/phone.js`), so `+998 90 123 45 67` and `901234567` are the same
caller. `npm run followups:rebuild` recomputes everything.

## API overview

All JSON under `/api`. Portal routes use the session cookie; `/api/device/*`
and `/api/calls/sync` use the device token.

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `POST /auth/change-password` |
| App | `POST /device/login`, `POST /device/session`, `GET /device/config`, `POST /device/logout` |
| Sync | `POST /calls/sync` (multipart: `payload` JSON part first, then `recording` files) |
| Calls | `GET /calls` (filters: `employeeId, callType, missed, hasRecording, followUp, needsCallback, phone, from, to, page`), `GET /calls/:id`, `PATCH /calls/:id/follow-up`, `GET /calls/:id/recording` (Range; AMR→MP3 on first play) |
| Dashboard | `GET /dashboard?from&to&tzOffset[&employeeId]` |
| Reports | `GET/PUT /reports/today`, `GET /reports/day?date&officeId`, `GET /reports`, `GET /reports/:id`, `POST /reports/:id/review` |
| Staff | `GET/POST /employees`, `GET/PATCH/DELETE /employees/:id`, `DELETE /employees/:id/devices/:deviceId`, `POST /employees/:id/reset-password`, `POST /employees/:id/regenerate-device-id` |
| Boss accounts | `GET/POST /users`, `PATCH/DELETE /users/:id`, `POST /users/:id/reset-password` |
| Calendar | `GET/POST /calendars`, `PATCH /calendars/:id` (usual week: `workDays, dayStart, dayEnd, lunch, slotMinutes`), `GET/PUT /calendars/:id/weeks/:monday` (PUT: `blocks`, optional `cancelAppointments, cancelReason`), `POST …/publish`, `POST /calendars/:id/appointments`, `GET /appointments?phone=|mine=true|attention=true`, `PATCH /appointments/:id` |
| Settings | `/offices`, `/positions`, `/report-templates` (GET for managers; writes DEVELOPER-only) |
| Diagnostics | `GET /sync-logs` |

`GET /downloads/ledger.apk` (outside `/api`) serves the Android app.

## Extending (AI and beyond)

- `src/lib/events.js` is the hook point: after each device sync the server
  emits `calls.synced` with the new call ids and which have recordings. The
  planned AI pipeline subscribes there (create `Transcript` rows, a worker
  transcribes, then fills `CallAnalysis`) — no route changes needed. The
  portal already shows transcript and review sections once rows exist.
- New per-person features follow the same pattern as "collect calls" and
  "report form": a setting on `Employee`, a preset on `Position`.

## Storage

- `prisma/*.db` — the SQLite database. Back it up.
- `storage/recordings/` — call recordings (client audio). Grows forever; back
  it up and watch disk space. Never commit (it's in `.gitignore`).
- `storage/recording-cache/` — MP3 conversions of AMR recordings; safe to
  delete any time.
- `storage/downloads/` — `ledger.apk` for installing the app.
