"""Ledger's transcriber: the firm's calls turned into text on the server, with
the firm's own Uzbek speech model (qirol4006/Whisper-3-turbo-uzbek, converted
to faster-whisper int8) — only when the server is free (the user's idea,
2026-10-24):

  - it runs at idle priority (systemd: Nice=19, CPUSchedulingPolicy=idle), so
    anything else — a page, the app, the phone line — always comes first;
  - it waits while anyone is on a call, and stops between pieces of a call it
    is working on as soon as a call starts;
  - it loads the model only when there is work and lets go of it after five
    quiet minutes; systemd caps it at 2 GB.

It asks Ledger for work and hands the text back through Ledger's hooks
listener on 127.0.0.1 (src/services/pbx/transcribe.js). Settings come from
/etc/ledger-transcriber.env (pbx/transcriber/install.sh).
"""
import gc
import json
import os
import subprocess
import sys
import time
import urllib.request

import numpy as np

HOOK = os.environ.get("LEDGER_HOOK", "http://127.0.0.1:4001").rstrip("/")
SECRET = os.environ.get("PBX_HOOK_SECRET", "")
MODEL_DIR = os.environ.get("MODEL_DIR", os.path.expanduser("~/uz-asr-server/models/qirol-ct2"))
THREADS = int(os.environ.get("THREADS", "4"))
ASK_EVERY = 20  # seconds between asking for work when there's none
UNLOAD_AFTER = 300  # seconds without work: free the model's memory


def log(*args):
    print(time.strftime("%H:%M:%S"), *args, flush=True)


def post(path, body=None, timeout=30):
    req = urllib.request.Request(
        HOOK + path,
        data=json.dumps(body or {}).encode("utf-8"),
        headers={"Content-Type": "application/json", "X-Ledger-Secret": SECRET},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.read().decode("utf-8")


def busy():
    """Someone is on a call (or Ledger can't say): wait."""
    try:
        return post("/pbx/busy", timeout=5).strip() != "0"
    except Exception:
        return True


def wait_until_free():
    waited = False
    while busy():
        waited = True
        time.sleep(1)
    return waited


def decode(path):
    """Any audio file -> 16 kHz mono floats (the system ffmpeg)."""
    pcm = subprocess.run(
        ["ffmpeg", "-nostdin", "-loglevel", "error", "-i", path, "-ac", "1", "-ar", "16000", "-f", "s16le", "-"],
        capture_output=True,
        check=True,
    ).stdout
    return np.frombuffer(pcm, np.int16).astype(np.float32) / 32768.0


def transcribe(model, audio):
    segments, _ = model.transcribe(audio, language="uz", beam_size=1, vad_filter=True, condition_on_previous_text=False)
    out = []
    # The text comes piece by piece; between pieces, step aside for calls.
    for s in segments:
        text = s.text.strip()
        if text:
            out.append({"start": round(s.start, 2), "end": round(s.end, 2), "text": text})
        wait_until_free()
    return out


def main():
    if not SECRET:
        sys.exit("PBX_HOOK_SECRET is not set (/etc/ledger-transcriber.env)")
    from faster_whisper import WhisperModel

    model = None
    last_work = time.time()
    log(f"ready: {MODEL_DIR}, {THREADS} threads, asking {HOOK}")
    while True:
        wait_until_free()
        try:
            job = json.loads(post("/pbx/transcribe/next") or "{}")
        except Exception as err:
            log("can't reach Ledger:", err)
            time.sleep(ASK_EVERY)
            continue
        if not job.get("id"):
            if model is not None and time.time() - last_work > UNLOAD_AFTER:
                model = None
                gc.collect()
                log("model let go (nothing to do)")
            time.sleep(ASK_EVERY)
            continue
        started = time.time()
        try:
            if model is None:
                model = WhisperModel(MODEL_DIR, device="cpu", compute_type="int8", cpu_threads=THREADS)
            lines = []
            seconds = 0.0
            for f in job["files"]:
                audio = decode(f["path"])
                seconds = max(seconds, len(audio) / 16000)
                for line in transcribe(model, audio):
                    lines.append({**line, "who": f["who"]})
            post("/pbx/transcribe/done", {"id": job["id"], "language": "uz", "segments": lines}, timeout=60)
            log(f"call {job['id']}: {seconds:.0f}s of audio -> {len(lines)} lines in {time.time() - started:.0f}s")
        except Exception as err:
            log(f"call {job['id']} failed:", err)
            try:
                post("/pbx/transcribe/failed", {"id": job["id"], "error": str(err)[:300]})
            except Exception:
                pass
        last_work = time.time()


if __name__ == "__main__":
    main()
