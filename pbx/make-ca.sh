#!/usr/bin/env bash
# Ledger's phone line: a certificate authority of its own (10 years) and the
# certificate the phone system shows phones over TLS. The Ledger app trusts
# only this authority: copy /etc/asterisk/keys/ledger-ca.crt to
# call-center-agent/app/src/main/res/raw/ledger_pbx_ca.pem.
#
# Run once (install.sh does). It never replaces existing keys — to start over,
# delete them by hand, and every app then needs the new ledger-ca.crt.
set -euo pipefail
HOST="${1:-82.115.51.61.nip.io}"
IP="${2:-82.115.51.61}"
KEYS=/etc/asterisk/keys
if sudo test -f "$KEYS/ledger-pbx.crt"; then
  echo "  certificates: already there ($KEYS)"
  exit 0
fi
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
openssl req -x509 -new -nodes -newkey rsa:3072 -sha256 -days 3650 -subj "/CN=Ledger phone line CA" -keyout ca.key -out ca.crt 2>/dev/null
openssl req -new -nodes -newkey rsa:2048 -sha256 -subj "/CN=$HOST" -keyout server.key -out server.csr 2>/dev/null
printf 'subjectAltName=DNS:%s,IP:%s\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' "$HOST" "$IP" > ext.cnf
openssl x509 -req -sha256 -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 3650 -extfile ext.cnf -out server.crt 2>/dev/null
sudo install -d -o root -g asterisk -m 750 "$KEYS"
sudo install -o root -g asterisk -m 640 server.key "$KEYS/ledger-pbx.key"
sudo install -o root -g asterisk -m 644 server.crt "$KEYS/ledger-pbx.crt"
sudo install -o root -g root -m 644 ca.crt "$KEYS/ledger-ca.crt"
# Only needed to make a new server certificate one day.
sudo install -o root -g root -m 600 ca.key /root/ledger-pbx-ca.key
echo "  certificates: made for $HOST / $IP (the app needs $KEYS/ledger-ca.crt)"
