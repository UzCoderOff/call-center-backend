#!/usr/bin/env bash
# One release on the VPS, in the order DEPLOY.md (section 1) gives. Run it
# from the backend folder:
#
#   bash scripts/deploy.sh
#
# It backs the database up first. If the database update fails, it goes
# back to the version that was running and starts it again, so the firm is
# never left with new code on an old database. It prints nothing secret.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
PORT_NUM="$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 | tr -d '"[:space:]')"
PORT_NUM="${PORT_NUM:-4000}"
step() { printf '\n== %s\n' "$1"; }
fail() { printf '\n!! %s\n' "$1"; exit 1; }

if [ -n "$(git status --short --untracked-files=no)" ]; then
  git status --short --untracked-files=no
  fail "The server's copy has local changes (above). Nothing was done — ask before discarding them."
fi
OLD="$(git rev-parse HEAD)"

step "1/6 New code"
git pull --ff-only || fail "git pull failed. Nothing was changed."
if [ "$(git rev-parse HEAD)" = "$OLD" ]; then
  echo "Already up to date — nothing new to deploy."
  exit 0
fi
git log --oneline "$OLD..HEAD"

step "2/6 Packages"
npm install --no-audit --no-fund || { git reset -q --hard "$OLD"; fail "npm install failed. Back on the old code; the server was not stopped."; }

step "3/6 Database backup"
npm run backup || { git reset -q --hard "$OLD"; npm install --no-audit --no-fund >/dev/null 2>&1; fail "The backup failed, so nothing else was done. Back on the old code; the server was not stopped."; }

step "4/6 Stopping the server (about half a minute offline; phones resend their calls)"
pm2 stop all

step "5/6 Database update (only adds tables and columns; keeps all data)"
if ! npx prisma migrate deploy; then
  # The failed migration isn't applied; any applied before it only added
  # tables or columns, which the old version doesn't notice.
  echo "The database update failed. Going back to the old version."
  git reset -q --hard "$OLD"
  npm install --no-audit --no-fund >/dev/null 2>&1
  npx prisma generate >/dev/null 2>&1
  pm2 restart all
  fail "Running the old version again. Send the error above to whoever helps you; the backup from step 3 is in storage/backups."
fi
npx prisma generate || fail "prisma generate failed after the database update. Run: npx prisma generate && pm2 restart all"

step "6/6 Starting"
pm2 restart all
for _ in 1 2 3 4 5 6 7 8 9 10; do
  sleep 2
  if curl -fsS --max-time 3 "http://localhost:${PORT_NUM}/health" >/dev/null 2>&1; then
    echo "The server answers on port ${PORT_NUM}."
    echo "Deployed: $(git log -1 --format='%h %s')"
    echo "Next: the portal (push it to GitHub; Vercel builds it), then the steps under \"Right after deploying\" in DEPLOY.md."
    exit 0
  fi
done
pm2 logs --nostream --lines 40 --no-color 2>/dev/null | tail -40
fail "The server didn't answer within 20 seconds (log above). The database is already updated; fix the cause and run: pm2 restart all"
