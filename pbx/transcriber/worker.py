"""Ledger's transcriber: the firm's calls turned into text on the server, with
the firm's own Uzbek speech model (qirol4006/Whisper-3-turbo-uzbek, converted
to faster-whisper int8) — only when the server is free (the user's idea,
2026-10-24):

  - it runs at idle priority (systemd: Nice=19, CPUSchedulingPolicy=idle), so
    anything else — a page, the app, the phone line — always comes first;
  - it waits while anyone is on a call, and stops between pieces of a call it
    is working on as soon as a call starts;
  - it loads the model only when there is work and lets go of it after five
    quiet minutes; systemd caps it at 2 GB;
  - one call can't run away with it (2026-10-28: a 14-second call sent the
    decoder round in circles to 3 GB and froze the server): each call has a
    time limit and a memory limit, watched by a thread that tells Ledger and
    ends the worker when one is passed (systemd starts it again), and a piece
    that keeps repeating, or doesn't move on in the audio, is dropped.

It asks Ledger for work and hands the text back through Ledger's hooks
listener on 127.0.0.1 (src/services/pbx/transcribe.js). Settings come from
/etc/ledger-transcriber.env (pbx/transcriber/install.sh).
"""
import gc
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.request
import zlib

import numpy as np

HOOK = os.environ.get("LEDGER_HOOK", "http://127.0.0.1:4001").rstrip("/")
SECRET = os.environ.get("PBX_HOOK_SECRET", "")
# The call-center Uzbek model (Abduqayum/whisper-uzbek-medium-callcenter, trained
# on telephone-band audio) — chosen 2026-10-24 over qirol-turbo, which garbled
# real line calls.
MODEL_DIR = os.environ.get("MODEL_DIR", os.path.expanduser("~/uz-asr-server/models/callcenter-ct2"))
# Beam 3: as good as 5 on real calls, and it leaves memory to spare.
BEAM = int(os.environ.get("BEAM_SIZE", "3"))
THREADS = int(os.environ.get("THREADS", "4"))
ASK_EVERY = 20  # seconds between asking for work when there's none
UNLOAD_AFTER = 300  # seconds without work: free the model's memory
# One call's limits. Time: 60 s + 3x the call's length, not counting waits for
# calls (calls took 0.5-1.7x their length, 2026-10-24..28). Memory: the worker's
# own — about 1.3 GB at work — below systemd's 1.8 GB, where the kernel starts
# squeezing everything.
TIME_BASE = float(os.environ.get("TIME_BASE", "60"))
TIME_FACTOR = float(os.environ.get("TIME_FACTOR", "3"))
MAX_MB = int(os.environ.get("MAX_MB", "1600"))


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


# The call being worked on, for guard(): its time limit runs only while the
# worker works (not while it waits for a call to end).
work = {"id": None, "limit": 0.0, "deadline": 0.0, "waiting": False, "peak": 0}


def memory_mb():
    """The worker's own memory, not counting files the system keeps cached."""
    try:
        with open("/proc/self/status") as f:
            for line in f:
                if line.startswith("RssAnon:"):
                    return int(line.split()[1]) // 1024
    except OSError:
        pass
    try:
        import psutil  # elsewhere (a test on the PC)

        return psutil.Process().memory_info().rss // 2**20
    except Exception:
        return 0


def watch(call, seconds):
    limit = TIME_BASE + TIME_FACTOR * seconds
    work.update(id=call, limit=limit, deadline=time.time() + limit, waiting=False, peak=memory_mb())


def guard():
    """A thread: a call past its time limit or over the memory limit has the
    decoder going round in circles — and nothing stops the decoder mid-step.
    Ledger is told (it tries the call once more, then gives up on it) and the
    worker ends at once, which gives the memory back; systemd starts it again
    in 30 s."""
    while True:
        time.sleep(1)
        call = work["id"]
        if call is None:
            continue
        mb = memory_mb()
        work["peak"] = max(work["peak"], mb)
        if mb > MAX_MB:
            why = f"used {mb} MB (limit {MAX_MB} MB)"
        elif not work["waiting"] and time.time() > work["deadline"]:
            why = f"not done in {work['limit']:.0f}s (limit for this call)"
        else:
            continue
        if work["id"] != call:  # it just finished
            continue
        log(f"call {call}: stopped, {why}")
        try:
            post("/pbx/transcribe/failed", {"id": call, "error": f"transcriber stopped: {why}", "stuck": True}, timeout=10)
        except Exception as err:
            log("couldn't tell Ledger:", err)
        os._exit(3)


def busy():
    """Someone is on a call (or Ledger can't say): wait."""
    try:
        return post("/pbx/busy", timeout=5).strip() != "0"
    except Exception:
        return True


def wait_until_free():
    """Wait while anyone is on a call; the call being worked on gets that time
    back."""
    started = time.time()
    work["waiting"] = True
    try:
        while busy():
            time.sleep(1)
    finally:
        work["deadline"] += time.time() - started
        work["waiting"] = False


def decode(path):
    """Any audio file -> 16 kHz mono floats (the system ffmpeg)."""
    pcm = subprocess.run(
        ["ffmpeg", "-nostdin", "-loglevel", "error", "-i", path, "-ac", "1", "-ar", "16000", "-f", "s16le", "-"],
        capture_output=True,
        check=True,
        timeout=120,
    ).stdout
    return np.frombuffer(pcm, np.int16).astype(np.float32) / 32768.0


TURN_GAP = 1.0  # seconds of silence that end a turn
SAME_MAX = 2  # the same piece back to back: kept twice, then dropped
STUCK_MAX = 3  # pieces in a row that don't move on in the audio: the decoder is going round


def looped(text):
    """A piece that repeats itself ("rahmat rahmat rahmat …"): its text squeezes
    far smaller than speech does (faster-whisper's own test, 2.4)."""
    raw = text.encode("utf-8")
    return len(raw) > 0 and len(raw) / len(zlib.compress(raw)) > 2.4


def transcribe(model, audio, label):
    """One side of a call as turns: one fast pass (speech only, timed word by
    word), then split where the speaker paused — so the two sides interleave
    in the right order. Between pieces, step aside for calls."""
    segments, _ = model.transcribe(
        audio,
        language="uz",
        beam_size=BEAM,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500},
        condition_on_previous_text=False,
        word_timestamps=True,
        # Against loops on noise: one retry hotter at most, with one sample —
        # not five retries of five samples each (five at once took 2.5 GB, over
        # systemd's cap); and made-up words in a silence skipped (which can also
        # move the decoder on from a word stuck at the very start of a window —
        # the loop that never ends). No cap on a window's tokens: even 300 lost
        # a sentence of a test call.
        temperature=(0.0, 0.4),
        best_of=1,
        hallucination_silence_threshold=2.0,
    )
    out = []
    reached = 0.0  # how far into the audio the pieces have come
    last, same, stuck, dropped = None, 0, 0, 0
    for s in segments:
        if s.end <= reached:
            stuck += 1
            if stuck >= STUCK_MAX:
                log(f"{label}: the decoder went round at {reached:.1f}s, the rest of this side skipped")
                break
            continue
        stuck = 0
        reached = s.end
        text = re.sub(r"\W+", "", s.text).lower()
        same = same + 1 if text == last else 1
        last = text
        if same > SAME_MAX or looped(s.text):
            dropped += 1
            continue
        for i, w in enumerate(s.words or []):
            if out and w.start - out[-1]["end"] <= TURN_GAP:
                # Within a piece the words carry their own spaces ("Xo" + "'p" is
                # one word, "qo'ymadingiz" + "-a" too); only a new piece's first
                # word can come without its space.
                joiner = " " if i == 0 and not w.word[:1].isspace() else ""
                out[-1]["text"] += joiner + w.word
                out[-1]["end"] = w.end
            else:
                out.append({"start": w.start, "end": w.end, "text": w.word})
        wait_until_free()
    if dropped:
        log(f"{label}: repeating pieces dropped: {dropped}")
    return [{"start": round(t["start"], 2), "end": round(t["end"], 2), "text": t["text"].strip()} for t in out if t["text"].strip()]


def main():
    if not SECRET:
        sys.exit("PBX_HOOK_SECRET is not set (/etc/ledger-transcriber.env)")
    from faster_whisper import WhisperModel

    model = None
    last_work = time.time()
    threading.Thread(target=guard, daemon=True).start()
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
            sides = [(f["who"], decode(f["path"])) for f in job["files"]]
            seconds = max((len(audio) / 16000 for _, audio in sides), default=0.0)
            watch(job["id"], seconds)
            lines = []
            for who, audio in sides:
                for line in transcribe(model, audio, f"call {job['id']} {who}"):
                    lines.append({**line, "who": who})
            work["id"] = None  # done: the guard lets go before Ledger is told
            post("/pbx/transcribe/done", {"id": job["id"], "language": "uz", "segments": lines}, timeout=60)
            log(f"call {job['id']}: {seconds:.0f}s of audio -> {len(lines)} lines in {time.time() - started:.0f}s, {work['peak']} MB at most")
        except Exception as err:
            work["id"] = None
            log(f"call {job['id']} failed:", err)
            try:
                post("/pbx/transcribe/failed", {"id": job["id"], "error": str(err)[:300]})
            except Exception:
                pass
        last_work = time.time()


if __name__ == "__main__":
    main()
