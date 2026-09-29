# Deploying Ledger

Three parts, deployed together: the **backend** (VPS), the **portal**
(Vercel), and the **Android app** (APK you hand out).

> **The database holds the firm's real data. Never delete the database file,
> never run `prisma migrate reset` on the VPS.** Updates only ever add to it.

Order: backend → portal → check on a phone → (Android app, when it changed).

---

## 1. Backend (on the VPS)

In the backend folder (the one you `git pull` in):

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

### This release: materials, Telegram bot, Moliya, tasks, fee in bookings, security fixes

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

`npm run backup` writes `storage/backups/ledger-YYYY-MM-DD.db` — a
consistent copy even while the server runs — and keeps the last 14. Run it
every night: `crontab -e` and add (use your folder; `which node` shows node's
path):

```
0 3 * * * cd /path/to/call-center-backend && /usr/bin/node scripts/backup-db.js >> storage/backups/backup.log 2>&1
```

These copies live on the same server — if its disk dies, they go with it.
About once a week copy the newest one to your computer (from your computer,
not inside the SSH session):

```bash
scp root@82.115.51.61:/path/to/call-center-backend/storage/backups/ledger-2026-10-01.db .
```

**Restoring** a backup: `pm2 stop all`; copy it over the database file
(the one `DATABASE_URL` points to, usually `prisma/dev.db`) and delete
`dev.db-wal` and `dev.db-shm` next to it if they exist; `pm2 start all`.
Don't copy the live database file with `cp` while the server runs — use
`npm run backup`.

Recordings (`storage/recordings`) are plain files; copy that folder the same
way now and then.

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
