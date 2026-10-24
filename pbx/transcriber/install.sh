#!/usr/bin/env bash
# Installs (or updates) Ledger's transcriber on the server — pbx/README.md,
# "Calls to text". Run from the backend:
#
#   bash pbx/transcriber/install.sh [backend .env]   (default ~/call-center-backend/.env)
#
# The model (~800 MB) must already be in ~/uz-asr-server/models/qirol-ct2: the
# firm's Uzbek model (qirol4006/Whisper-3-turbo-uzbek) converted to
# faster-whisper int8 on the PC (ct2-transformers-converter --quantization
# int8 --copy_files tokenizer.json preprocessor_config.json) and copied over.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BACKEND_ENV="${1:-$HOME/call-center-backend/.env}"
DIR="$HOME/uz-asr-server"
MODEL="$DIR/models/qirol-ct2"

[ -f "$MODEL/model.bin" ] || { echo "The model isn't in $MODEL yet (see the top of this script)." >&2; exit 1; }
[ -f "$BACKEND_ENV" ] || { echo "No backend .env at $BACKEND_ENV" >&2; exit 1; }
SECRET="$(grep '^PBX_HOOK_SECRET=' "$BACKEND_ENV" | cut -d= -f2-)"
PORT="$(grep '^PBX_HOOK_PORT=' "$BACKEND_ENV" | cut -d= -f2- || true)"
[ -n "$SECRET" ] || { echo "PBX_HOOK_SECRET isn't in $BACKEND_ENV (is the phone line installed?)" >&2; exit 1; }

mkdir -p "$DIR"
install -m 644 "$HERE/worker.py" "$DIR/worker.py"
[ -x "$DIR/.venv/bin/python" ] || python3 -m venv "$DIR/.venv"
"$DIR/.venv/bin/pip" install -q --disable-pip-version-check "faster-whisper==1.2.1"
command -v ffmpeg >/dev/null || sudo apt-get install -y ffmpeg

umask 077
printf 'PBX_HOOK_SECRET=%s\nLEDGER_HOOK=http://127.0.0.1:%s\nMODEL_DIR=%s\nTHREADS=4\n' "$SECRET" "${PORT:-4001}" "$MODEL" | sudo tee /etc/ledger-transcriber.env > /dev/null
sudo chmod 600 /etc/ledger-transcriber.env
sudo install -m 644 "$HERE/ledger-transcriber.service" /etc/systemd/system/ledger-transcriber.service
sudo systemctl daemon-reload
sudo systemctl enable --now ledger-transcriber
sudo systemctl restart ledger-transcriber
sleep 3
systemctl --no-pager --lines 5 status ledger-transcriber | sed -n '1,12p'
