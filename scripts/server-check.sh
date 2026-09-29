#!/usr/bin/env bash
# A read-only health check of the Ledger server. It changes nothing and
# prints nothing secret (no .env values, no passwords, no client data).
# Run it on the VPS from the backend folder and paste the output to whoever
# is helping you:
#
#   bash scripts/server-check.sh
cd "$(dirname "$0")/.." || exit 1
section() { printf '\n== %s\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }

section "System"
uname -srm
grep -m1 PRETTY_NAME /etc/os-release 2>/dev/null | cut -d= -f2 | tr -d '"'
uptime

section "Disk and memory"
df -h / | tail -1
free -h 2>/dev/null | sed -n '1,2p'
du -sh prisma storage/recordings storage/materials storage/backups 2>/dev/null

section "Node and the app"
echo "node $(node -v 2>/dev/null || echo missing), npm $(npm -v 2>/dev/null || echo missing)"
if have pm2; then pm2 ls --no-color 2>/dev/null; else echo "pm2: not found"; fi
echo "health: $(curl -s --max-time 5 "http://localhost:${PORT:-4000}/health" || echo 'no answer on localhost')"
echo "public: $(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://82.115.51.61.nip.io/health) (200 = the site answers over HTTPS)"
echo "git: $(git log -1 --format='%h %cd %s' --date=short 2>/dev/null); local changes: $(git status --short 2>/dev/null | grep -vc '^??')"

section "Recent errors in the app log (last 15 lines)"
if have pm2; then pm2 logs --nostream --lines 300 --err --no-color 2>/dev/null | grep -v '^\s*$' | tail -15; fi

section "Settings (.env names only — never the values)"
if [ -f .env ]; then
  grep -oE '^[A-Z_]+=' .env | tr -d '=' | tr '\n' ' '
  echo
  grep -q '^NODE_ENV=production' .env && echo "NODE_ENV=production: yes" || echo "NODE_ENV=production: NO (recommended)"
  echo "JWT_SECRET length: $(awk -F= '/^JWT_SECRET=/{print length(substr($0, index($0, "=") + 1))}' .env) (32+ is good)"
else
  echo ".env: MISSING"
fi

section "Database"
ls -la prisma/*.db* 2>/dev/null
npx --no-install prisma migrate status 2>&1 | grep -Ei 'migrations? (found|have not|are)|database schema is up to date|following migration' | head -4

section "Backups"
ls -1t storage/backups/*.db 2>/dev/null | head -3 || true
[ -n "$(ls storage/backups/*.db 2>/dev/null)" ] || echo "no backups yet"
crontab -l 2>/dev/null | grep -q backup-db && echo "nightly backup: scheduled" || echo "nightly backup: NOT scheduled"

section "Security"
if have sshd; then
  sshd -T 2>/dev/null | grep -Ei '^(passwordauthentication|permitrootlogin|port) ' || grep -Ei '^\s*(PasswordAuthentication|PermitRootLogin|Port)\s' /etc/ssh/sshd_config
fi
if have ufw; then ufw status 2>/dev/null | head -8; else echo "ufw firewall: not installed"; fi
if have fail2ban-client; then echo "fail2ban: $(systemctl is-active fail2ban 2>/dev/null)"; else echo "fail2ban: not installed"; fi
echo "listening ports: $(ss -tln 2>/dev/null | awk 'NR>1{n=split($4,a,":"); print a[n]}' | sort -un | tr '\n' ' ')"
if have apt; then echo "system updates waiting: $(apt list --upgradable 2>/dev/null | grep -c upgradable)"; fi
