# Call Center Backend

The server behind the firm's staff system ("Ledger"): portal logins, staff and
offices, daily reports, call recording/monitoring for call-center staff, the
lawyer's calendar and the clients database.
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
call-center, three office staff), ~30 days of calls, ~10 days of reports, the
lawyer's calendar with bookings, and ~50 made-up clients (every case status,
court stages, full/partial/no payment, connections, one archived, one entered
twice to try merging). Run it again any time: it resets the demo data.

`npm test` runs the unit tests (Node's built-in test runner, Node 21+).

## Who can do what

| | Employee | Lawyer | Boss | Developer |
|---|---|---|---|---|
| Own stats, calls (if collected), reports | ✓ | — | ✓ everyone's | ✓ everyone's |
| Calendar | per their access | their own | all | all |
| Clients | if they take calls / book | only those with a case assigned to them; can move those cases and write notes | all | all |
| Review reports | — | — | ✓ | ✓ |
| See staff, settings | — | — | read-only | ✓ edit |
| Create/remove accounts, reset passwords, sign out phones | — | — | — | ✓ |
| Contract money (contract amounts, contract payments, debts, the Moliya page) | — | only with "Moliya" on (own cases) | only with "Moliya" on | ✓ always |
| Consultation fee (see it, record it) | ✓ | ✓ (see) | ✓ | ✓ |
| Training materials | the ones meant for them | the ones meant for them | write, choose who sees, see who read | same as Boss |
| Telegram notifications | ✓ (own) | ✓ (own) | ✓ (own) + who has connected | same as Boss |

Boss and Lawyer accounts are the same kind of account (Team → Boss and
lawyers) with one switch, **"Sees everything"**: on = Boss (the head of the
firm), off = Lawyer. A second switch, **"Moliya"** (off by default), lets an
account see the money from clients — meant for the head of the firm only;
only the DEVELOPER can turn it on (`src/lib/finance.js`). Anything not explicitly opened to a role is closed to
it (`src/middleware/auth.js`).

## Training materials

**Materiallar** in the portal: scripts, how to work with clients, rules —
text written in the portal (with simple formatting: headings, lists, "say
this" lines for call scripts, warnings), a link (YouTube, Google Drive), and
files (PDF, Word, Excel, pictures, audio such as a good call, short videos;
50 MB each). Each material is for everyone, some positions, the lawyers, or
named people. **Required** ones sit on the person's home page until they
press "Oʻqidim" (I've read it) — a new employee's to-read list. The boss sees
who has read what, can ask everyone to read a changed material again, and
can announce it on Telegram. Rules: `src/services/materials.js`; files are
stored in `storage/materials` (MATERIALS_DIR) and only served to the people
the material is for.

## Telegram bot

A staff bot (create it with @BotFather, set `TELEGRAM_BOT_TOKEN`). Each person
connects their own Telegram from **Profile → Telegram** (a one-time link) and
chooses what they get:

- **Uchrashuvlar** — the lawyer hears about new bookings; whoever booked hears
  when the lawyer cancels, with the client's number to call.
- **Javobsiz qoʻngʻiroqlar** — a missed call nobody returned in 15 minutes
  (8:00–21:00) goes to the person whose phone missed it.
- **Ertalabki xulosa** — 8:30, Mon–Sat: today's appointments, clients to call,
  calls to return, materials to read; for managers, yesterday in numbers.
- **Hisobot eslatmasi** — 17:30 if today's report form isn't in.
- **Yangi materiallar** — a material announced for them.
- **Jadval eslatmasi** — Thursday/Friday if next week's calendar isn't confirmed.

In the bot: 📅 Bugun (my day), 🗓 Ertaga (tomorrow's appointments),
⚙️ Sozlamalar (switch kinds on/off), /uzish (disconnect). The bot only talks
in private chats with connected people, shows each person only what the
portal shows them, and never sends client phone numbers to lawyers. It
receives messages by long polling, so it needs no public address; only one
running server may use a token (`TELEGRAM_POLLING=false` on a test machine).
Code: `src/services/telegram/`.

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
  number, amount (soʻm), yes/no, one choice, several choices, and **table** —
  rows the person adds, like lines in Excel, with the columns the form sets
  (e.g. Service | People served | Income | Note). Each submitted report stores
  the questions as they were, so editing a form never changes old reports.
  Managers see a day's totals, or a **period's** (a week, a month, any dates):
  per question, per kind for tables (income and people per service), and per
  person — and download a form's reports as Excel (a line per table row).
  See `src/services/reportFields.js`.
- **Automatic report** — per person (preset on the position; on for
  call-center staff): nothing to fill in, the day's report is worked out from
  their calls (answered, missed, called back, still to call back, talk time),
  the appointments they booked, clients added, consultations, contracts and
  payments recorded. Computed when viewed, never stored, so late-syncing
  calls still count. A report form set on the person is kept (not asked) and
  comes back if automatic is switched off. See `src/services/autoReport.js`.

## The lawyer's calendar

Every lawyer — a BOSS or LAWYER account — can keep a calendar (Team → Boss
and lawyers → "Keeps a calendar"); staff book with whichever lawyer the client
needs, and a booking assigns the client's case to that lawyer. Its settings are the lawyer's **usual week** — working days,
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

## Clients

The client base the call center works from (replaces the Excel CRM). Who:
bosses and developers, and staff who take calls or book appointments.

- **Client** — name, phone numbers (matched by their last 9 digits, so no
  number belongs to two clients by accident), city, where they came from,
  notes, the **next call** to make (with what it's about). Search finds a name
  typed in Latin or Cyrillic either way, a phone number, or a case number.
- **Lawyers** — a case is assigned to a lawyer account (`lawyerId`; its name
  is kept in `lawyer` too), by picking one, by booking into their calendar,
  or on import when the sheet's lawyer column names exactly one account
  (`src/lib/lawyers.js`). A lawyer without an account can still be written by
  name. LAWYER accounts see only clients with a case assigned to them, and of
  those only their own cases, payments and history — no calls, no connections.
- **Cases** — what the client came for, each with a **status**
  (consultation → call again → contract → finished / declined) and, once
  signed, the **court stage** (inquiry … supreme court review), lawyer, case
  number, contract amount and **payments** (paid / still owed). The first
  consultation and the contract are dated when reached; the monthly
  **targets** set on a position count those dates per operator.
- **History** — status and stage changes, notes, imports, merges, plus the
  client's calls and appointments; **connections** between clients (family,
  who referred whom, the same case).
- Calls show the client's name instead of a bare number, and a booking in the
  calendar finds or creates its client (with a consultation for the booker).

**Many at once** (managers, Mijozlar → Tanlash): tick clients, a whole page,
or everything a filter matches, then assign an operator or a lawyer to all
their cases, or close their consultations as **"didn't continue"** (status
`declined`; contracts are never touched and consultations keep counting toward
the operator's month). The "old consultations" filter (consultation or "call
again" over 30 days old, or undated from the old sheets, with no contract)
finds the ones to close. `POST /clients/bulk` — logged in the change log.

Nothing is thrown away: "delete" **archives** a client (hidden from lists,
restorable, re-activated by a new booking); **merge** moves everything of a
duplicate into the right record; deleting a case or a payment, merging,
archiving and importing are kept in the **change log** (Settings), with a copy
of what was deleted. **Import** reads Excel or Google Sheets (the portal parses
the file, `src/services/clientImport.js` matches and merges: by the ID column
of our own export, by phone, by an unambiguous exact name) — importing the same
file twice changes nothing. **Export** gives an .xlsx of the current list that
imports back unchanged. Logic: `src/services/clients.js`,
`src/routes/clients.js`.

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
| Calls | `GET /calls` (filters: `employeeId, callType, missed, hasRecording, followUp, needsCallback, phone, from, to, page`; `sort=longest`; returns `summary` with total talk time), `GET /calls/:id`, `PATCH /calls/:id/follow-up`, `GET /calls/:id/recording` (Range; AMR→MP3 on first play) |
| Dashboard | `GET /dashboard?from&to&tzOffset[&employeeId]` |
| Reports | `GET/PUT /reports/today` (automatic: `auto` instead of a form; PUT refused), `GET /reports/day?date&officeId` (rows with `auto`, team totals in `auto`), `GET /reports/auto?employeeId&date` or `&days=14` / `&from&to` (max 62 days), `GET /reports/summary?from&to&officeId` (managers; per form totals and per person, max 366 days), `GET /reports/export?templateId&from&to&officeId` (managers; .xlsx), `GET /reports`, `GET /reports/:id`, `POST /reports/:id/review` |
| Staff | `GET/POST /employees`, `GET/PATCH/DELETE /employees/:id`, `DELETE /employees/:id/devices/:deviceId`, `POST /employees/:id/reset-password`, `POST /employees/:id/regenerate-device-id` |
| Boss and lawyers | `GET/POST /users` (`role`: BOSS or LAWYER, `name`), `PATCH /users/:id` (`role`, `name`, `active`, `hasCalendar`), `DELETE /users/:id`, `POST /users/:id/reset-password` |
| Calendar | `GET/POST /calendars`, `PATCH /calendars/:id` (usual week: `workDays, dayStart, dayEnd, lunch, slotMinutes`), `GET/PUT /calendars/:id/weeks/:monday` (PUT: `blocks`, optional `cancelAppointments, cancelReason`), `POST …/publish`, `POST /calendars/:id/appointments`, `GET /appointments?phone=|mine=true|attention=true`, `PATCH /appointments/:id` |
| Clients | `GET /clients` (`q, filter=callToday|debt|active|archived, status, legalStage, operatorId, lawyer, page`), `GET /clients/export` (same filters, .xlsx), `GET /clients/lookup?phone`, `GET /clients/lawyers`, `GET /clients/targets`, `POST /clients`, `GET/PATCH/DELETE /clients/:id` (DELETE archives), `POST /clients/:id/restore`, `POST /clients/:id/merge` (`otherId`), `POST /clients/:id/cases|payments|notes|links`, `PATCH/DELETE /client-cases/:id`, `DELETE /client-payments/:id`, `DELETE /client-notes/:id`, `DELETE /client-links/:id`, `POST /clients/import` (`rows`), `GET /clients/import/google?url` |
| Change log | `GET /audit` (managers: the last 100 archive/restore/merge/delete/import entries) |
| Settings | `/offices`, `/positions` (incl. monthly `targetConsultations`, `targetContracts`), `/report-templates` (GET for managers; writes DEVELOPER-only) |
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

- `prisma/*.db` — the SQLite database (WAL mode, set at startup; the
  `-wal`/`-shm` files next to it belong to it). `npm run backup` writes a
  consistent dated copy to `storage/backups/` and keeps 14 — run it nightly
  (DEPLOY.md → Backups).
- `storage/recordings/` — call recordings (client audio). Grows forever; back
  it up and watch disk space. Never commit (it's in `.gitignore`).
- `storage/recording-cache/` — MP3 conversions of AMR recordings; safe to
  delete any time.
- `storage/downloads/` — `ledger.apk` for installing the app.
