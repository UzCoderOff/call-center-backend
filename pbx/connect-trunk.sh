#!/usr/bin/env bash
# Connects the outside line (SkyLine) — pbx/README.md, "The outside line".
# Run on the server, from the backend:
#
#   printf '%s' '<password>' | sudo bash pbx/connect-trunk.sh --host pbx.skyline.uz \
#        --user 781139001 --password-stdin
#
#   --host            their SIP server (a name or an address)
#   --port            its port (5060 unless they say otherwise)
#   --user            the login they gave (our number, 781139001); with
#   --password-stdin  its password, read from stdin — never on the command
#                     line, where it would show in the process list and history
#   --ips             more addresses their calls may come from (their --host is
#                     looked up and always allowed)
#   --number          our number as they want it on calls out (default: --user)
#
# It writes /etc/asterisk/pjsip_trunk.conf (readable only by Asterisk), opens
# the firewall to their addresses on 5160/udp, reloads Asterisk and shows the
# line. Running it again replaces the settings. Nothing in Ledger changes:
# after it, Sozlamalar -> Telefon liniyasi -> the company number and "outside
# line connected" on.
set -euo pipefail

HOST="" PORT="5060" IPS="" NUMBER="" USERNAME="" PASSWORD=""
while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --ips) IPS="$2"; shift 2 ;;
    --number) NUMBER="$2"; shift 2 ;;
    --user) USERNAME="$2"; shift 2 ;;
    --password-stdin) IFS= read -r PASSWORD || true; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
NUMBER="${NUMBER:-$USERNAME}"

ip_re='^([0-9]{1,3}\.){3}[0-9]{1,3}(/[0-9]{1,2})?$'
[[ "$HOST" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "--host is required (their SIP server)" >&2; exit 2; }
[[ "$PORT" =~ ^[0-9]{2,5}$ ]] || { echo "--port must be a number" >&2; exit 2; }
[[ "$NUMBER" =~ ^\+?[0-9]{7,15}$ ]] || { echo "--number (or --user) must be digits" >&2; exit 2; }
if [ -n "$USERNAME" ]; then
  [[ "$USERNAME" =~ ^[A-Za-z0-9_.+-]{1,64}$ ]] || { echo "--user: letters and digits only" >&2; exit 2; }
  # Nothing that could end a line or start a comment in the config file.
  [[ "$PASSWORD" =~ ^[A-Za-z0-9!@#%^*_+=.,:/?~-]{6,128}$ ]] || { echo "the password (stdin) is missing or has characters the config can't hold" >&2; exit 2; }
fi

# Their addresses: the server's own (looked up now) and any given.
ADDRS=()
if [[ "$HOST" =~ $ip_re ]]; then ADDRS+=("$HOST"); else
  while read -r a; do [ -n "$a" ] && ADDRS+=("$a"); done < <(getent ahostsv4 "$HOST" | awk '{print $1}' | sort -u)
fi
IFS=',' read -ra parts <<< "$IPS"
for a in "${parts[@]}"; do
  a="$(echo "$a" | tr -d ' ')"
  [ -z "$a" ] && continue
  [[ "$a" =~ $ip_re ]] || { echo "not an address: $a" >&2; exit 2; }
  ADDRS+=("$a")
done
[ ${#ADDRS[@]} -gt 0 ] || { echo "couldn't find $HOST's address; give it with --ips" >&2; exit 2; }
MATCH="$(printf '%s\n' "${ADDRS[@]}" | sort -u | paste -sd, -)"

OUT=/etc/asterisk/pjsip_trunk.conf
[ -f "$OUT" ] && cp -a "$OUT" "$OUT.bak-$(date +%Y%m%d-%H%M%S)"
umask 027
{
  cat <<EOF
; The outside line (SkyLine): the company number, +998 78 113-90-01.
; Written by pbx/connect-trunk.sh (pbx/README.md, "The outside line") - run it
; again rather than editing here. On the plain-SIP transport, 5160/udp, which
; the firewall opens only to SkyLine's addresses. Their calls can only reach
; [from-trunk] (extensions.conf).

[skyline]
type=endpoint
transport=transport-udp
context=from-trunk
disallow=all
allow=alaw,ulaw
dtmf_mode=rfc4733
direct_media=no
rtp_symmetric=yes
force_rport=yes
rewrite_contact=yes
media_encryption=no
aors=skyline
from_user=$NUMBER
from_domain=$HOST
send_pai=yes
trust_id_inbound=yes
rtp_timeout=60
EOF
  [ -n "$USERNAME" ] && echo "outbound_auth=skyline-auth"
  cat <<EOF

[skyline]
type=aor
contact=sip:$HOST:$PORT
qualify_frequency=60

[skyline]
type=identify
endpoint=skyline
match=$MATCH
EOF
  if [ -n "$USERNAME" ]; then
    cat <<EOF

; Signing in to their server with our login, from our address (which they
; let in). line/endpoint: their calls to us are matched to this sign-in.
[skyline-auth]
type=auth
auth_type=userpass
username=$USERNAME
password=$PASSWORD

[skyline-reg]
type=registration
transport=transport-udp
outbound_auth=skyline-auth
server_uri=sip:$HOST:$PORT
client_uri=sip:$USERNAME@$HOST
contact_user=$USERNAME
expiration=300
retry_interval=60
forbidden_retry_interval=600
max_retries=10000
line=yes
endpoint=skyline
EOF
  fi
} > "$OUT"
chown root:asterisk "$OUT"
chmod 640 "$OUT"
echo "wrote $OUT (their server $HOST:$PORT, calls from $MATCH${USERNAME:+, signing in as $USERNAME})"

if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  for a in $(echo "$MATCH" | tr ',' ' '); do
    ufw allow from "$a" to any port 5160 proto udp comment "SkyLine" >/dev/null
    echo "firewall: $a may reach 5160/udp"
  done
fi

asterisk -rx "module reload res_pjsip.so" >/dev/null
sleep 4
asterisk -rx "pjsip show registrations" | grep -E "skyline|Registered|Rejected|Unregistered" || true
asterisk -rx "pjsip show aor skyline" | grep -E "Contact:" || true
cat <<'EOF'

Next:
  1. Ledger -> Sozlamalar -> Telefon liniyasi: the company number (+998781139001)
     and "outside line connected" on.
  2. Call the company number from any phone: the call-center operators ring.
  3. Call a client from the Ledger app: they see +998 78 113-90-01.
  If calls out are refused, check the number format they want (TRUNK_PREFIX
  in extensions.conf: "998" + 9 digits).
EOF
