#!/usr/bin/env bash
# Sets up Asterisk on the server for Ledger's phone line (Ubuntu 24.04), from
# the files next to this script. Run from the backend folder after pulling:
#
#   bash pbx/install.sh
#
# Safe to run again: it backs up /etc/asterisk first, keeps existing keys and
# secrets, and only touches Ledger's parts. Afterwards restart the backend
# from a NEW login (it needs the ledgerpbx group): see pbx/README.md.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BACKEND="$(cd "$HERE/.." && pwd)"
ENV_FILE="$BACKEND/.env"
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l

echo "1. Packages (asterisk, ffmpeg, fail2ban)"
sudo -E apt-get install -y -qq --no-upgrade asterisk ffmpeg fail2ban > /dev/null

echo "2. Backup of /etc/asterisk"
STAMP="$(date +%Y%m%d-%H%M%S)"
sudo cp -a /etc/asterisk "/etc/asterisk.before-ledger-$STAMP"
echo "   /etc/asterisk.before-ledger-$STAMP"

echo "3. Secrets in $ENV_FILE (kept if already there)"
add_secret() {
  grep -q "^$1=." "$ENV_FILE" && return
  sed -i "/^$1=/d" "$ENV_FILE"
  printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"
  echo "   added $1"
}
add_secret PBX_AMI_SECRET "$(openssl rand -hex 24)"
add_secret PBX_HOOK_SECRET "$(openssl rand -hex 24)"
add_secret PBX_SECRET_KEY "$(openssl rand -hex 32)"
AMI_SECRET="$(grep '^PBX_AMI_SECRET=' "$ENV_FILE" | cut -d= -f2-)"

echo "4. Folders shared by Asterisk and Ledger (group ledgerpbx)"
sudo groupadd -f ledgerpbx
sudo usermod -aG ledgerpbx asterisk
sudo usermod -aG ledgerpbx "$USER"
sudo install -d -o "$USER" -g ledgerpbx -m 2750 /etc/asterisk/ledger
# Not under /var/spool/asterisk: only Asterisk may enter that.
sudo install -d -o root -g ledgerpbx -m 2750 /var/spool/ledger-pbx
sudo install -d -o asterisk -g ledgerpbx -m 2770 /var/spool/ledger-pbx/calls /var/spool/ledger-pbx/recordings
# The firm's voice messages: Ledger writes them, Asterisk (the group) plays them.
sudo install -d -o "$USER" -g ledgerpbx -m 2750 /var/spool/ledger-pbx/sounds
for f in pjsip_staff.conf extensions_ledger.conf globals_ledger.conf; do
  [ -f "/etc/asterisk/ledger/$f" ] || sudo install -o "$USER" -g ledgerpbx -m 640 /dev/null "/etc/asterisk/ledger/$f"
done
# Files Asterisk writes (recordings, call files) readable by the group.
sudo mkdir -p /etc/systemd/system/asterisk.service.d
printf '[Service]\nUMask=0007\n' | sudo tee /etc/systemd/system/asterisk.service.d/ledger.conf > /dev/null

echo "5. Certificates for TLS"
bash "$HERE/make-ca.sh"

echo "6. Asterisk settings"
for f in pjsip.conf extensions.conf queues.conf rtp.conf logger.conf; do
  sudo install -o root -g asterisk -m 640 "$HERE/asterisk/$f" "/etc/asterisk/$f"
done
sed "s/__AMI_SECRET__/$AMI_SECRET/" "$HERE/asterisk/manager.conf" | sudo tee /etc/asterisk/manager.conf > /dev/null
sudo chown root:asterisk /etc/asterisk/manager.conf
sudo chmod 640 /etc/asterisk/manager.conf
# Old and unused channel drivers off (one of them listens on 5060).
for m in chan_sip chan_iax2 chan_motif chan_unistim chan_skinny chan_mgcp; do
  sudo grep -q "^noload => $m.so" /etc/asterisk/modules.conf || sudo sed -i "/^autoload=yes/a noload => $m.so" /etc/asterisk/modules.conf
done

echo "7. Blocking password guessers (fail2ban)"
sudo install -m 644 "$HERE/fail2ban-asterisk.local" /etc/fail2ban/jail.d/ledger-asterisk.local
sudo touch /var/log/asterisk/messages.log

echo "8. Restarting Asterisk and fail2ban"
sudo systemctl daemon-reload
sudo systemctl restart asterisk
sudo systemctl enable --now fail2ban > /dev/null 2>&1
sudo systemctl restart fail2ban

echo "9. Firewall: phones over TLS (5161) and call audio; plain SIP (5160) closed"
sudo ufw allow 5161/tcp comment "Ledger phones: SIP over TLS" > /dev/null
sudo ufw allow 10000:10399/udp comment "Ledger phones: call audio" > /dev/null
sudo ufw delete allow 5160/udp > /dev/null 2>&1 || true
sudo ufw delete allow 5160/tcp > /dev/null 2>&1 || true

sleep 4
echo
echo "Asterisk: $(systemctl is-active asterisk), fail2ban: $(systemctl is-active fail2ban)"
sudo asterisk -rx "pjsip show transports" | grep -E "^Transport:" || true
echo
echo "Next: restart the backend from a NEW login so it can use the ledgerpbx"
echo "group (pbx/README.md, 'After installing')."
