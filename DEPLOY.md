# Deploying Ledger

Three parts, deployed together: the **backend** (VPS), the **portal**
(Vercel), and the **Android app** (APK you hand out).

> **The database holds the firm's real data. Never delete the database file,
> never run `prisma migrate reset` on the VPS.** Updates only ever add to it.

Order: backend → portal → check on a phone → (Android app, when it changed).

---

## 1. Backend (on the VPS)

In the backend folder (the one you `git pull` in), either run the script
that does all of the steps below in order — it backs up first, and if the
database update fails it goes back to the old version and starts it again:

```bash
bash scripts/deploy.sh
```

or do them by hand:

```bash
git pull
npm install
npm run backup              # a dated copy of the database first (see Backups)
pm2 stop all                # half a minute offline: the running server can
                            # keep the database busy ("database is locked")
npx prisma migrate deploy   # applies only the new migrations — keeps all data
npx prisma generate
pm2 restart all             # or however the server is run
```

If `migrate deploy` stops with an error, nothing was applied. Fix the cause
and run it again, then `npx prisma generate` and `pm2 restart all` — don't
start the server on the new code before the migration has gone through.
Phones keep their calls and send them again, so the pause loses nothing.

The startup log should say `database: journal mode wal`, `listening on port
…`, and where ffmpeg was found (needed to play AMR recordings).

`.env` only changes when a release says so — compare with `.env.example`.

### This release (2026-10-03): old consultations to the archive by themselves; missed reports filled in by the developer

- **Old consultations leave the lists by themselves.** A client with no
  contract who has had nothing happen for 14 days — no call, note, status
  change, appointment, payment or follow-up — goes to the archive (checked
  every hour; services/clientArchive.js). It goes by the client's real dates,
  not the day they were typed in or imported. Never archived: anyone with an
  appointment or a planned call ahead, or marked **«Arxivga tushmasin»** on
  their page (2 weeks, 1 month, 3 months or a date). Archived clients are in
  Mijozlar → Arxiv and come back by themselves when booked again; the
  timeline says "archived automatically". Sozlamalar → **Eski
  konsultatsiyalar**: on/off and the number of days (developer).
  **The first run (a minute after the update) archives the old ones at once —
  about 70 of today's ~98 consultations.**
- **The developer fills in a report someone missed**: Hisobotlar → a day →
  tap the person ("bosing — siz kiritasiz"), or open a report → Tahrirlash.
  Any day up to today; the report shows "Kiritgan: …" and the audit log keeps
  it. Staff still send only today's.
- `npm run backup`, `pm2 stop all`, `npx prisma migrate deploy`, `npx prisma
  generate`, `pm2 restart all` as above (the auto-deploy does all of it). One
  migration, only adding:
  - `20261004120000_keep_clients_entered_reports` — `Client.keepUntil` and
    `Report.enteredById` (empty: nothing changes).

### Earlier release (2026-10-02/03): jobs, coordinators and case history; plans for any income; phones that don't record; simpler Moliya; Russian

- **Who does what (Ish turi):** call center, coordinator, office, other. The
  call-back list, booking counts and missed-call Telegram are the call
  center's; Calls and Home show it by default, with switches for the rest.
- **The handover at the contract:** the operator owns the consultation; once
  the client signs, the boss or developer assigns a coordinator and a lawyer
  (Telegram tells them; managers hear "contract signed — assign"). The
  operator keeps a result view. The coordinator sees the whole case, its
  money too (payments, schedule, what's overdue) and records payments on it;
  a lawyer sees the whole case without money (unless the Moliya switch).
- **Case history:** stages with dates (past dates allowed, for a case
  brought in from before), key dates (hearings, summons, deadlines — with
  what happened), the case's milestones (came in, consultation, contract,
  closed) and every change on the client's timeline. Notes can be edited and
  removed — removed ones are hidden, kept, and in the audit log.
- **The client page** is rebuilt around this: people on each case, stage
  history, key dates, money, and one filterable timeline. Coordinators get
  their own home page (my cases: overdue, due soon, dates coming up).
- **Booking:** "Ofisda / Onlayn" must be chosen each time (no default).

- `npm run backup`, `pm2 stop all`, `npx prisma migrate deploy`, `npx prisma
  generate`, `pm2 restart all` as above. Two migrations, both only adding
  (no table is rebuilt, no existing value changes):
  - `20261002000000_recording_health` — one empty column on the sync log
    (whether the app may read the phone's files).
  - `20261003000000_jobs_coordinator_case_history` — each person's job, the
    coordinator on a case, a case's court and closing date, stage history and
    key dates, edit/remove marks on notes. It fills in each person's job from
    their settings (operators → call center, report-form staff → office) and
    gives every case that has a stage its first history row (date
    approximate).
- **Right after deploying (developer):**
  1. **Xodimlar → each person → Ish sozlamalari → «Ish turi»**: check it
     (call center / coordinator / office / other) and set your coordinators.
     Only the call center's missed calls go on the call-back list and to
     Telegram; Calls and Home show the call center by default (the others are
     switches on those pages).
  2. **Mijozlar → «Tayinlash kerak»**: every contract that has no
     coordinator or lawyer yet. «Tanlash» → «Koordinator biriktirish» puts one
     coordinator on many at once.
  3. Operators now see their signed clients only as results (name, number,
     dates, their own calls) under **Mijozlar → «Natijalarim»** — tell them
     before the update.
  4. A case's stages are now a dated history. The current stage of each case
     became its first row, with an approximate date — correct the ones that
     matter on the case («Ish bosqichlari» → ✎), and add earlier stages with
     their own dates.
- Deploy the backend first, then the portal (it uses the new endpoints), then
  the 2.3.0 app (`UPDATE-APP-ON-SERVER.cmd`: set NAME=2.3.0, CODE=5 at the
  top). Older apps keep working; they just don't report file access.
- **All income as a target** (Natijalar → a person → "Reja qoʻyish"): the
  sheet now lists everything the person can be measured on — type how much
  per month next to each, save once. "Jami tushum" (all money they brought
  in: payments on their clients plus report income marked Tushum) is offered
  to people with Moliya. Staff see that one only in percent — never soʻm.
- **Staff see their plan:** a "Bu oygi rejangiz" card on their home page, and
  a Telegram message when a plan is set or changed (new kind "Oylik reja").
- **Phones that don't record calls:** Ledger can't record calls itself —
  it sends what the phone's own recorder saves. Over the last 7 days each
  phone's answered calls are compared with the recordings that arrived:
  managers see a red list on the home page and a badge in Xodimlar; the
  person sees a red card with the fix (in the app it opens the setup guide);
  both get a Telegram note at 10:00 while it lasts (new kind "Qoʻngʻiroq
  yozuvlari"). App 2.3.0 adds a setup step: switch on automatic recording
  in the Phone app.
- **Disk space:** the developer's home page and Telegram (9:00) warn when
  the server has under 5 GB or 10% free — recordings are never deleted.
- **Moliya → Umumiy** shows the month's money first (with six months as
  small columns), then debts / new contracts / consultations (each opens its
  tab), warnings only when something needs doing; the long breakdown and the
  other tables fold away.
- **Russian** in the portal (Profile → language, and on the sign-in page).
  Uzbek stays the default. The Telegram bot and the app's own screens are
  still in Uzbek.
- **New look:** Ledger's own colours instead of the stock iPhone ones, a
  graphite dark mode, and a floating tab bar on phones.

#### Same release, part 2: follow-ups, connected people, documents, the funnel, strikes

- **Next steps (follow-ups) on each client:** call, waiting for a decision
  (1/2/3/7/14 days, one tap), meeting, documents, payment — with whom (the
  client or a connected person), when, who does it. When it's due the person
  gets it on Home ("Bugun qilinadigan ishlar") and in Telegram (new kind
  "Keyingi qadamlar", with a "Bajarildi" button). Closing one asks how it went
  (talked / no answer / yes / no / another time) and offers the next step;
  "said no" can close the consultation with a reason. The old "call again"
  date is now just the earliest open follow-up.
- **Family and representatives** on each client (father, spouse,
  representative… who decides ★). Calls from their numbers show on the
  client.
- **Why a consultation didn't continue:** choosing "Davom etmadi" asks for a
  reason (price, will think, other lawyer, couldn't reach…). Reasons show in
  the funnel.
- **Clients with no next step** (Home): open consultations with nothing
  planned and no appointment coming.
- **Documents** on each client (contract, power of attorney, court
  decision…), up to 50 MB each, stored in `CLIENT_FILES_DIR` (default
  `storage/client-files`), included in the off-site backup.
- **Notes say how a talk happened:** Telegram, meeting, another phone, SMS.
- **From calls to contracts (funnel)** under the call numbers on Home and on
  a person's page: different numbers (people, not calls) → talked to →
  booked → came → signed, who was never talked to, and (managers) an
  estimate of what that cost.
- **Who is the call center** (Settings → Call-markaz): pick people one by
  one or a whole position / office / report form at once. Home's call
  numbers, the funnel and strikes count only them.
- **Strikes for late call-backs** (Settings → Ogohlantirishlar): **off until
  the developer switches it on**, and it only ever counts calls after that
  moment. A missed call (in working hours, on the person's working days) not
  called back within N minutes is a strike; over the monthly limit the
  managers get a Telegram message, with the fine if one is set. A strike
  removes itself if an in-time call-back turns up later; managers can remove
  one with a reason (Natijalar → the person). Staff see their count, not the
  fine. Daily reports, Natijalar and its Excel show them.
- Migration `20261004000000_contacts_followups_strikes_files` — only adds
  (5 new tables, 2 empty columns on cases). It turns every client's current
  "call again" date into an open follow-up for that client's operator.
- **Right after deploying (developer):**
  1. Settings → **Call-markaz**: check the list (it starts from each
     person's «Ish turi»).
  2. Settings → **Ogohlantirishlar**: set the minutes, working hours, the
     monthly limit (and a fine, if the firm wants one), tell the call center,
     then switch it on.
  3. Home → **Bugun qilinadigan ishlar** will show old "call again" dates
     that already passed as late — the operators can close or move them.

### Previous release (2026-09-30): detailed Moliya, report money, online consultations, Natijalar, days off, payment schedules, Kassa, backups

- `npm run backup`, `pm2 stop all`, `npx prisma migrate deploy`, `npx prisma
  generate`, `pm2 restart all` as above. Three migrations, all only adding:
  - `20260930120000_appointment_format` — whether a consultation is in the
    office or online (a plain `ADD COLUMN`; every existing one is "office").
  - `20260930180000_employee_cost` — a new table for what each person costs
    per month (nothing existing changes).
  - `20260930200000_work_schedule_and_money` — work patterns on staff and
    positions (plain `ADD COLUMN`s; call-center staff — calls collected — are
    set to every day, holidays worked; everyone else Mon–Sat, holidays off),
    and new tables: holidays, days away, contract payment schedules, cash
    handovers.
- **Right after deploying (developer):** open **Dam olish** — Ledger suggests
  Uzbekistan's fixed holidays; **confirm 1 October** (and the others you
  agree with; "Bayram emas" for any that aren't). Only confirmed ones count.
  Add Ramazon / Qurbon hayiti when their dates are announced. Check each
  person's work pattern in **Xodimlar → the person → Edit** (weekdays, and
  "Bayramlarda dam oladi").
- **Dam olish** (new menu item): staff ask for a day off, report sick, or say
  they worked away from the office; the boss or the developer approves.
  Approved days (and holidays, for people they apply to) are left out of
  Natijalar targets, "reports due", the reports-of-the-day list and the 17:30
  Telegram reminder.
- **Payment schedules** (Moliya only): on a contract case → "Toʻlov jadvali".
  Moliya → Qarzlar then splits debt into overdue / next 14 days / later /
  no schedule, with the overdue list.
- **Kassa** (Moliya tab): cash staff took (recorded as cash payments) and
  handed over — "Qabul qildim". Counted from 1 October 2026
  (`CASH_TRACKING_FROM` in `.env` changes it). Cash the boss or the developer
  records counts as already in the cash box.
- **Where clients come from** (Moliya → Umumiy) and **Excel** buttons on Moliya
  and Natijalar.
- **Backups to Google Drive:** see "Backups" below — set it up once after this
  update (`npm run backup:offsite-setup`).
- **Natijalar** (new menu item): each person's month — calls, consultations
  they booked and what came of them, consultations and contracts against
  their position's target (and where they should be by today), conversion,
  money they brought in and the cash they took, reports and tasks on time,
  six months back; charts on each person's page. Managers see everyone,
  staff only themselves (no contract money, no cost).
- **Monthly cost per person** (Moliya only): on a person's Natijalar page →
  **Oylik xarajat** — salary + bonuses + taxes as one amount, from a month
  on (kept until changed; old months keep their figure). Then the page shows
  the return (money brought in ÷ cost) and cost per consultation/contract.
- **The consultation fee no longer counts towards the contract**: a client
  who paid 450 000 for a consultation and signed a 10 000 000 contract owes
  10 000 000. Debts on the client page, in the list and on Moliya follow.
- **Moliya** now has tabs — Umumiy, Konsultatsiyalar, Shartnomalar, Qarzlar,
  Barcha yozuvlar — and shows where every soʻm came from: consultation fees,
  contract payments (new contracts vs. installments), other payments, and
  money written in staff reports; expenses and net; by payment method, by
  person, by day, by lawyer; consultations (came, paid, not paid, online,
  went on to a contract); debts by how old they are. "Bu raqamlar qanday
  hisoblanadi?" at the bottom explains each figure.
- **Money in reports counts only once you mark it.** Right after deploying:
  **Sozlamalar → Hisobot shakllari →** each form **→** each money question
  (and money column of a table) **→ "Moliyada"**: *Tushum* (money the firm
  received), *Xarajat* (money spent), or *Hisoblanmasin* — for money that's
  also recorded as a client payment in Ledger (the consultation fee), so it
  isn't counted twice. Until then Moliya lists them as "not marked yet".
  Marking a question also counts the reports sent before.
- Booking: **Ofisda / Onlayn**; the calendar shows "Onlayn" and whether the
  consultation fee is paid ("Toʻlangan" / "Toʻlanmagan") on every booking.
- A consultation fee recorded on the client's page now belongs to their
  appointment (the calendar shows it paid). On first start the server ties
  the fees recorded earlier to the nearest appointment of that client
  (within 60 days) — the log says how many.

### Previous release (2026-09-30): each client only for their own people; a booking is a consultation

- No new migrations — the usual steps above are enough (`npm run backup`,
  `pm2 stop all`, `npx prisma migrate deploy` says "No pending migrations",
  `npx prisma generate`, `pm2 restart all`).
- **Who sees a client** (it was everyone who works with clients): you, the
  head of the firm, the lawyer on one of its cases, and the employee who is
  its operator. Whoever added a client sees it until someone else is made
  its operator. Everyone else doesn't find it in lists or search and can't
  open it; in calls, "this number already exists" and connections they see
  only "Boshqa xodimning mijozi (name)", so they know whom to ask.
- **Calendar**: someone else's booking shows only as "Band" (no name, phone
  or matter) and can't be opened, changed or cancelled by them.
- **A booking is a consultation**: booking a "call again" client makes it a
  consultation; a client with no operator gets whoever booked them. The
  client page has **"Konsultatsiyaga yozish"**, and after adding a client
  or a consultation the portal asks (optional) whether to book it too.
- After deploying, operators will see fewer clients — only their own. If a
  client is missing for someone, make them its operator: Mijozlar → the
  client → Ishni tahrirlash → Masʼul operator (or tick several clients in
  the list → Operator biriktirish).

### Earlier release (2026-09-29): materials, Telegram bot, Moliya, tasks, fee in bookings, security fixes

- `npm run backup` first, then `npx prisma migrate deploy` and `npx prisma
  generate` as above. Two migrations, both only adding:
  - `20260929000000_materials_telegram` — new tables (materials, who they're
    for, their files, who read them; Telegram connections and sent
    notifications).
  - `20260929120000_finance_access` — two columns on accounts (the "Moliya"
    switch, and "logins before this moment don't count") and an index that
    speeds up the calls list. Plain `ADD COLUMN`s: the accounts table is not
    rebuilt.
  - `20260929180000_tasks` — the tasks table, and on payments which
    appointment a consultation fee paid for (a plain `ADD COLUMN`: the
    payments table is not rebuilt; existing payments are untouched).
  - `20260929200000_auto_report_with_form` — one switch on staff and on
    positions for the new daily-report choice "Avtomatik + shakl" (automatic
    numbers AND a form to fill in). Plain `ADD COLUMN`s, off for everyone:
    nothing changes until you pick it in **Xodimlar → the person → Edit →
    Kunlik hisobot** (or on a position in Sozlamalar).
- New for staff: the booking form has **"Konsultatsiya toʻlovi olindi"**
  (the fee, 450 000 soʻm by default — `CONSULTATION_FEE` in `.env` changes
  it), and an appointment can take the fee later. **Mijozlar** now has two
  tabs: clients with a contract, and **Konsultatsiyalar** (everyone else); a
  search looks in both. **Vazifalar**: the boss gives someone a task with a
  due time; Telegram reminds them an hour before and when it's due, and they
  can tick it done right in Telegram.
- **Contract money is now hidden from everyone but you** (the DEVELOPER)
  until you switch it on: contract amounts, contract payments and debts
  disappear for the boss too. Right after deploying: **Xodimlar → Rahbar va
  advokatlar → the head of the firm → "Moliyani koʻradi" on**. They get the
  new **Moliya** page (income, contracts, who owes, per lawyer). Nobody else
  — other lawyers, staff — sees contract money or records contract payments.
  The consultation fee (450 000 soʻm) stays visible: staff still record it
  on the client's case ("Toʻlov qoʻshish") before booking.
- Security fixes that change behaviour:
  - Resetting someone's password now also signs their phones out of the app
    and ends their other logins. Changing your own password ends your other
    logins (not the phone app).
  - Too many wrong passwords now stop only strangers: the person still
    signs in from a phone or browser they've used before. (The login sets a
    second cookie, `kd_…`, for this.)
  - Boss and lawyer accounts' phones are listed on their account and can be
    signed out, like staff phones.
  - A lawyer booking a known client's number into their own calendar no
    longer gets that client's file; staff can't move a case to another
    lawyer or take a colleague off a case (managers still can).
  - A boss or lawyer account with appointments can't be deleted (it would
    delete them) — deactivate it instead.
- Reliability fixes: recordings whose file names have Cyrillic or ʻ are no
  longer lost; a phone with a big backlog (more than 50 recordings) is no
  longer stuck forever; a sync waits out a busy database instead of failing;
  backups are checked before they replace the day's copy.
- `.env` — add (see `.env.example`):
  - `PORTAL_URL=https://call-center-frontend-hazel.vercel.app` (links in
    Telegram messages).
  - `TELEGRAM_BOT_TOKEN=` — in Telegram, open **@BotFather**, send `/newbot`,
    give it the name **Ledger** and a username ending in `bot` (e.g.
    `firmname_ledger_bot`), and paste
    the token it gives you. Treat it like a password. Leave it empty and the
    bot stays off; everything else works.
  - `pm2 restart all`. The log should say `[telegram] bot @… ready`.
- Uploaded material files are stored in `storage/materials` — copy that folder
  with the recordings when you take copies off the server.
- Files go up in pieces under 1 MB, so no web server setting needs changing.
- The Android app **2.2.0 (versionCode 4)** opens PDFs and Excel exports,
  can pick files to upload (older versions can't — the portal tells people to
  update), and works through a backlog of calls 30 recordings at a time
  instead of getting stuck. After the new APK is built and copied to `storage/downloads/ledger.apk`,
  set `APP_LATEST_VERSION_CODE=4` and `APP_LATEST_VERSION_NAME=2.2.0` and
  restart, so installed apps offer the update.
- Afterwards: **Materiallar → Yangi material** (boss or developer) — start
  with the call-center script, mark it **Majburiy**, choose the call-center
  position. Ask everyone to open **Profil → Telegram → Telegramni ulash**;
  **Sozlamalar → Telegram** shows who hasn't yet.

### Earlier release: the clients database and automatic reports

- The migration `20260928000000_clients` adds the new tables (clients, their
  phone numbers, cases, payments, history, connections, the change log) and
  links appointments to their client. Nothing existing is removed — staff,
  logins and passwords, phones, calls, recordings and reports stay as they
  are.
- The migration `20260928120000_auto_reports` adds one switch per person and
  per position and turns it on for everyone whose calls are collected: their
  daily report is automatic from now on (nothing to fill in). A report form
  set on them (e.g. a custom one) is kept, just not asked; switch it back per
  person in **Team → the person → Edit → Avtomatik hisobot**.
- The migration `20260928140000_lawyers` adds a name to boss/lawyer accounts
  and lets cases be assigned to a lawyer. **Every existing boss account keeps
  seeing everything** — nobody is locked out by the update. Then, as the
  DEVELOPER, in **Team → Rahbar va advokatlar**: open each lawyer who
  shouldn't see everything, give them their name, and switch **"Hamma narsani
  koʻradi"** off. From that moment they see only their own calendar and the
  clients whose cases are assigned to them. Leave it on only for the head of
  the firm. Do this before importing the Excel file, so its "Advokat" column
  is matched to the right lawyers.
- Afterwards, as the DEVELOPER: **Settings → Positions → the call-center
  operator position → monthly targets** (consultations, contracts).
- Bring in the Excel CRM: **Mijozlar → Exceldan import** (boss or
  developer). Pick the .xlsx — or paste a Google Sheets link shared "anyone
  with the link can view" — check whose each sheet is and how its columns
  were understood, import. Importing the same file again is safe: nothing is
  duplicated.
- Set up the nightly backup (next section) — once.

### Backups

Every night at 03:00 (Tashkent) the server makes a copy of the database
(`storage/backups/ledger-YYYY-MM-DD.db`, the last 14 kept) and sends it —
**encrypted** — to the firm's backup Google account's Drive, with the new
call recordings and materials. Drive keeps every day for a month and the last
copy of each month for a year. The developer gets a line on Telegram each
night: "✅ Zaxira nusxa …" or what went wrong.

**Setting it up (once):**

1. On the server: `sudo apt update && sudo apt install -y rclone`
2. On your own computer (Windows): `winget install Rclone.Rclone`, open a
   new terminal, and run
   `rclone authorize "drive" "eyJzY29wZSI6ImRyaXZlLmZpbGUifQ"`.
   A browser opens: sign in with the **backup Google account** and allow.
   The terminal then prints a line starting `{"access_token":` — copy all of
   it. (This lets the backup see only the files it creates in that account.)
3. On the server, in the backend folder: `npm run backup:offsite-setup`,
   paste the line. It tests Drive, **prints two passwords — save them outside
   the server** (password manager or paper; without them the backups can't
   be opened, and nobody can recover them), and adds the nightly job to cron.
4. `npm run backup:offsite` — the first run (uploads all recordings once, so
   it can take a while).

`npm run backup` alone still makes a local copy (do it before every update,
as above).

**Getting a backup back:** `npm run backup:restore` lists what's on Drive;
`npm run backup:restore -- ledger-2026-10-01.db` downloads and checks one into
`storage/backups/restored/` — it never touches the live database. To use it:
`pm2 stop all`, `npm run backup` (a copy of the current one first), copy it
over the database file (the one `DATABASE_URL` points to, usually
`prisma/dev.db`), delete `dev.db-wal` and `dev.db-shm` next to it if they
exist, `pm2 restart all`. Don't copy the live database with `cp` while the
server runs — use `npm run backup`.

**If the server is gone:** on a new machine, install rclone, run the setup's
step 2 again to get a token, and write `storage/offsite/rclone.conf` with the
same two passwords (`rclone obscure <password>` for each):

```
[gdrive]
type = drive
scope = drive.file
token = <the line from rclone authorize>

[ledger-backup]
type = crypt
remote = gdrive:ledger-backups
filename_encryption = standard
directory_name_encryption = true
password = <obscured password>
password2 = <obscured password2>
```

then `npm run backup:restore`.

## 2. Portal (Vercel)

Push the `call-center-portal` repo; Vercel builds it automatically.
`vercel.json` forwards `/api/*` to the VPS — that is the fix for "Couldn't
load stats" on phones. The old `VITE_API_URL` variable in Vercel's settings is
no longer used and can be deleted.

## 3. Check it on a phone

Open https://call-center-frontend-hazel.vercel.app on an iPhone and an Android
phone, sign in, and open Overview, Calls and Mijozlar. Everything should load.

## 4. Android app

### Once: the signing key

Every app version must be signed with the same key, or phones refuse to
install updates. Create it once, on your computer, in Git Bash:

```bash
cd call-center-agent
bash tools/create-signing-key.sh
```

It creates `ledger-release.p12` and prints four values. In GitHub:
**call-center-agent → Settings → Secrets and variables → Actions → New
repository secret**, add `LEDGER_KEYSTORE_BASE64` (run `base64 -w0
ledger-release.p12` and paste the output), `LEDGER_KEYSTORE_PASSWORD`,
`LEDGER_KEY_ALIAS`, `LEDGER_KEY_PASSWORD`.

Keep `ledger-release.p12` and its password safe (password manager + a
backup). Never commit it — it's in `.gitignore`.

### Each release

1. Push `call-center-agent` (or run the "Build APK" workflow by hand).
2. In GitHub → Actions → the run → **Artifacts**, download `ledger-apk` and
   unzip `ledger.apk`.
3. Copy it to the VPS: `storage/downloads/ledger.apk` (next to
   `storage/recordings`). It's then at
   https://82.115.51.61.nip.io/downloads/ledger.apk
4. In `.env` set `APP_LATEST_VERSION_CODE` to the new `versionCode`
   (`app/build.gradle`, currently `3`) and `APP_LATEST_VERSION_NAME` (e.g.
   `2.1.0`), restart. Installed apps offer the update on their next open.

### On each phone

1. **Only once, on the phone that has the old "Call Agent":** uninstall it.
   (It was signed with a different key, so the new app can't replace it.)
2. Open https://82.115.51.61.nip.io/downloads/ledger.apk in the phone's
   browser, install (allow "install from unknown sources").
3. Open **Ledger**, sign in with the person's portal username and password.
4. Call-center staff are then guided through phone setup, one step per
   screen with exactly what to tap: call log, recordings (all files),
   battery, and on Honor / Huawei / Xiaomi phones **auto-launch** (the app
   opens the right settings screen; Honor's menu names are shown in Uzbek and
   Russian). Everyone else goes straight to the portal — their phone isn't
   read at all. The guide can be opened again any time from Profile →
   *Telefonni sozlash* inside the app.

## 5. Set up the firm (portal, as the DEVELOPER)

1. **Settings → Offices:** add each office.
2. **Settings → Report forms:** build the daily form for each kind of job
   (translation, document services, call center…). You can edit them any
   time; old reports keep the questions they were answered with.
3. **Settings → Positions:** e.g. "Call-center operator" (collect calls on,
   call-center form), "Translator" (off, translation form)…
4. **Team → Add employee:** name, username, office, position (fills in the
   rest). Give them the username and temporary password shown — the same
   login works in the app and the portal.
5. **Team → Rahbar va advokatlar**: an account for the head of the firm
   (*Hamma narsani koʻradi* on) and one per lawyer (off — they see only their
   own calendar and cases), each with "Keeps a calendar" on
   (default). Each lawyer signs in and, once, opens Calendar → *Sozlamalar*:
   working days, hours, lunch (12:00–13:00 by default — move it or switch
   it off). From then on each new week is already filled in; the lawyer
   changes any day that's different (*Kunni oʻzgartirish* → busy all day,
   day off…) and presses *Tasdiqlash* so staff can book.
6. Give call-center positions calendar access *View and book* (Settings →
   Positions) so operators can book appointments.
7. On the same position, set the **monthly targets** (consultations,
   contracts); operators see their progress on the Mijozlar page.
8. **Mijozlar → Exceldan import** the existing client spreadsheets.

## 6. Moving to your own domain (when you buy one)

A domain is a name you rent yearly (about $10–15 for a .com; .uz names come
from registrars listed on cctld.uz). After buying, in the domain's **DNS
settings** add:

| Type | Name | Value |
|---|---|---|
| A | `api` | `82.115.51.61` |
| CNAME | `portal` | what Vercel shows under Project → Settings → Domains after you add `portal.yourdomain` there |

Then:

1. On the VPS, serve `api.yourdomain` over HTTPS (the same reverse proxy that
   serves the nip.io address today; Caddy/Certbot get the certificate free).
2. Portal: change the destination in `vercel.json` to
   `https://api.yourdomain/api/:path*`, push.
3. Backend `.env`: `CORS_ORIGIN=https://portal.yourdomain`,
   `APP_DOWNLOAD_URL=https://api.yourdomain/downloads/ledger.apk`, restart.
4. App: in `call-center-agent/gradle.properties` set `ledger.portalUrl` and
   `ledger.apiUrl`, bump `versionCode`/`versionName` in `app/build.gradle`,
   release as in step 4. Keep the old addresses working until every phone has
   updated.

## Troubleshooting

- **How is the server doing?** In the backend folder run
  `bash scripts/server-check.sh` — read-only, prints nothing secret: disk,
  memory, the app and its recent errors, database migrations, backups, HTTPS,
  SSH/firewall settings, pending updates. Paste the output to whoever helps.
- **A phone isn't syncing:** Team → the person → *Phone sync* shows the last
  success and the last error. In the app, Profile → *Share diagnostics* sends
  the phone's own log (Telegram etc.).
- **Portal says it can't load on a phone but works on a computer:** the
  `/api` proxy isn't in place — check `vercel.json` was deployed.
- **Recordings don't play:** the backend log at startup says whether ffmpeg
  was found; `apt install ffmpeg` on the VPS fixes it.
- **Someone lost their phone:** Team → the person → *Phones signed in to the
  app* → Sign out. Then reset their password.
