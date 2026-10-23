#!/usr/bin/env bash
# Connects the outside line (SkyLine) once they've sent their settings —
# pbx/README.md, "The outside line". Run on the server, from the backend:
#
#   sudo bash pbx/connect-trunk.sh --host <their SIP server> [--port 5060] \
#        --ips "<their address>,<another>" [--number 781139001]
#
#   --host    where our calls out go (their SIP server, a name or an address)
#   --port    its port (5060 unless they say otherwise)
#   --ips     the addresses their calls come from (the firewall lets only these
#             in, on 5160/udp; their --host is added when it's an address)
#   --number  our number as they want it on calls out (9 digits by default)
#
# It writes /etc/asterisk/pjsip_trunk.conf from pbx/asterisk/pjsip_trunk.conf.template,
# opens the firewall to their addresses, reloads Asterisk and shows the line.
# Running it again replaces the settings. Nothing in Ledger changes: after it,
# Sozlamalar -> Telefon liniyasi -> the company number and "outside line
# connected" on.
set -euo pipefail

HOST="" PORT="5060" IPS="" NUMBER="781139001"
while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --ips) IPS="$2"; shift 2 ;;
    --number) NUMBER="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

ip_re='^([0-9]{1,3}\.){3}[0-9]{1,3}(/[0-9]{1,2})?$'
[[ "$HOST" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "--host is required (their SIP server)" >&2; exit 2; }
[[ "$PORT" =~ ^[0-9]{2,5}$ ]] || { echo "--port must be a number" >&2; exit 2; }
[[ "$NUMBER" =~ ^\+?[0-9]{7,15}$ ]] || { echo "--number must be digits" >&2; exit 2; }
ADDRS=()
IFS=',' read -ra parts <<< "$IPS"
for a in "${parts[@]}"; do
  a="$(echo "$a" | tr -d ' ')"
  [ -z "$a" ] && continue
  [[ "$a" =~ $ip_re ]] || { echo "not an address: $a" >&2; exit 2; }
  ADDRS+=("$a")
done
[[ "$HOST" =~ $ip_re ]] && ADDRS+=("$HOST")
[ ${#ADDRS[@]} -gt 0 ] || { echo "--ips is required (the addresses their calls come from)" >&2; exit 2; }
MATCH="$(printf '%s\n' "${ADDRS[@]}" | sort -u | paste -sd, -)"

DIR="$(cd "$(dirname "$0")" && pwd)"
TEMPLATE="$DIR/asterisk/pjsip_trunk.conf.template"
OUT=/etc/asterisk/pjsip_trunk.conf
[ -f "$TEMPLATE" ] || { echo "missing $TEMPLATE" >&2; exit 1; }

[ -f "$OUT" ] && cp -a "$OUT" "$OUT.bak-$(date +%Y%m%d-%H%M%S)"
sed -e "s|__HOST__|$HOST|g" -e "s|__PORT__|$PORT|g" -e "s|__MATCH__|$MATCH|g" -e "s|__FROM_USER__|$NUMBER|g" "$TEMPLATE" > "$OUT"
chown root:asterisk "$OUT" 2>/dev/null || true
chmod 640 "$OUT"
echo "wrote $OUT (their server $HOST:$PORT, calls from $MATCH)"

if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  for a in $(echo "$MATCH" | tr ',' ' '); do
    ufw allow from "$a" to any port 5160 proto udp comment "SkyLine" >/dev/null
    echo "firewall: $a may reach 5160/udp"
  done
fi

asterisk -rx "module reload res_pjsip.so" >/dev/null
sleep 2
asterisk -rx "pjsip show endpoint skyline" | sed -n '1,40p'
asterisk -rx "pjsip show aor skyline" | grep -E "Contact|Status" || true
cat <<'EOF'

Next:
  1. Ledger -> Sozlamalar -> Telefon liniyasi: the company number (+998781139001)
     and "outside line connected" on.
  2. Call the company number from any phone: the call-center operators ring.
  3. Call a client from the Ledger app: they see +998 78 113-90-01.
  If calls out are refused, check the number format they want (TRUNK_PREFIX
  in extensions.conf: "998" + 9 digits).
EOF
