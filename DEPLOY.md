# Deploying Ledger

Three parts, deployed together: the **backend** (VPS), the **portal**
(Vercel), and the **Android app** (APK you hand out). This version resets the
database — the old test data (calls, the two test recordings) is not kept.

Order: backend → portal → check on a phone → Android app → set up the firm.

---

## 1. Backend (on the VPS)

```bash
cd /path/to/call-center-backend
git pull
npm install
```

Reset the database (the test data isn't needed):

```bash
# Make a backup copy first, just in case — the file DATABASE_URL points to
# (usually prisma/dev.db):
cp prisma/dev.db ~/ledger-old-$(date +%F).db
rm prisma/dev.db
rm -rf storage/recordings storage/recording-cache
```

If `git status` lists any **untracked** folders under `prisma/migrations/`,
delete them — they're from the old setup; the only migration now is
`20260926000000_init`.

Update `.env` (compare with `.env.example`):

```
COOKIE_SECURE=true
COOKIE_SAME_SITE=lax
CORS_ORIGIN=https://call-center-frontend-hazel.vercel.app
FIRM_TIMEZONE=Asia/Tashkent
APP_DOWNLOAD_URL=https://82.115.51.61.nip.io/downloads/ledger.apk
APP_LATEST_VERSION_CODE=        # leave empty until step 4
APP_LATEST_VERSION_NAME=
```

Create the database and the first DEVELOPER account, then restart:

```bash
npx prisma migrate deploy
npx prisma generate
npm run seed          # DEVELOPER from ADMIN_USERNAME / ADMIN_PASSWORD
pm2 restart all       # or however the server is run (systemctl restart …)
```

The startup log should say `listening on port …` and report where ffmpeg was
found (needed to play AMR recordings).

## 2. Portal (Vercel)

Push the `call-center-portal` repo; Vercel builds it automatically.
`vercel.json` forwards `/api/*` to the VPS — that is the fix for "Couldn't
load stats" on phones. The old `VITE_API_URL` variable in Vercel's settings is
no longer used and can be deleted.

## 3. Check it on a phone

Open https://call-center-frontend-hazel.vercel.app on an iPhone and an Android
phone, sign in, and open Overview and Calls. Everything should load. (Sign in
again on desktop too — old sessions are gone after the reset.)

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
5. **Team → Boss accounts** for the lawyer, with "Keeps a calendar" on
   (default). The lawyer signs in and, once, opens Calendar → *Sozlamalar*:
   working days, hours, lunch (12:00–13:00 by default — move it or switch
   it off). From then on each new week is already filled in; the lawyer
   changes any day that's different (*Kunni oʻzgartirish* → busy all day,
   day off…) and presses *Tasdiqlash* so staff can book.
6. Give call-center positions calendar access *View and book* (Settings →
   Positions) so operators can book appointments.

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

- **A phone isn't syncing:** Team → the person → *Phone sync* shows the last
  success and the last error. In the app, Profile → *Share diagnostics* sends
  the phone's own log (Telegram etc.).
- **Portal says it can't load on a phone but works on a computer:** the
  `/api` proxy isn't in place — check `vercel.json` was deployed.
- **Recordings don't play:** the backend log at startup says whether ffmpeg
  was found; `apt install ffmpeg` on the VPS fixes it.
- **Someone lost their phone:** Team → the person → *Phones signed in to the
  app* → Sign out. Then reset their password.
