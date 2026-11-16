# Listen mode's local voice: Kokoro-82M through mlx-audio, run by
# `operator-inbox serve` as a long-lived child (`src/readout-kokoro.ts`) the
# first time a page asks for audio, and stopped with serve.
#
#   python -I readout-kokoro.py <voice>
#
# The protocol is JSON lines, one request at a time: serve writes one line to
# stdin, this answers one line on stdout.
#
#   -> {"segments": [{"id", "text", "pauseAfter"}], "out": "<path>",
#       "pace": "now" | "background"}
#   <- {"type": "done", "duration": s, "segments": [{"id", "start", "end",
#       "words": [{"from", "to", "start", "end"}]}]}
#   <- {"type": "error", "message": "..."}
#
# Before the first request it loads the model, warms it up and says
# {"type": "ready"}; when mlx-audio cannot be imported it says
# {"type": "fatal", "reason": "unavailable", "message": "..."} and exits.
#
# The model runs on the GPU, and a long run at full speed starves the window
# server, so the whole machine stutters. So the pace: "now" (the Question the
# operator is waiting on) runs at full speed, a short burst; "background" (the
# lookahead, which nobody waits on) runs as a background process to macOS
# (efficiency cores, low I/O and GPU priority) and rests between segments for
# half as long as each took, so the GPU is never held for long. MLX's cache of
# freed buffers is capped and emptied after each request.
#
# Each segment is spoken on its own, with British phonemes; the segments are
# joined with `pauseAfter` seconds of silence and written to `out` as a
# constant-bitrate MP3, 24 kHz mono. The word timings are Kokoro's own, from
# its duration predictor, mapped onto character offsets in each segment's
# text.
#
# It exits when stdin closes, and when its parent changes (serve died without
# closing the pipe), so it never outlives serve.

import json
import os
import re
import sys
import threading
import time

# stdout is the protocol. Anything a library prints goes to stderr instead.
protocol = os.fdopen(os.dup(1), "w", buffering=1)
os.dup2(2, 1)
sys.stdout = sys.stderr

os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
os.environ.setdefault("TQDM_DISABLE", "1")

MODEL = "mlx-community/Kokoro-82M-bf16"
RATE = 24000
# soundfile's MP3 quality, 0 (highest bitrate) to 1 (lowest); 0.5 is about
# 80 kbit/s, plenty for speech.
MP3_COMPRESSION = 0.5
# A background request rests this many times as long as each segment took.
REST = 0.5
# MLX keeps freed GPU buffers for reuse; this caps what it keeps.
CACHE_LIMIT = 64 * 1024 * 1024
VOICE = sys.argv[1] if len(sys.argv) > 1 else "bm_george"
WORD = re.compile(r"\w", re.UNICODE)


def say(message):
    protocol.write(json.dumps(message) + "\n")
    protocol.flush()


def set_pace(pace):
    """macOS's background band for "background", the normal one otherwise."""
    try:
        os.setpriority(
            os.PRIO_DARWIN_PROCESS,
            0,
            os.PRIO_DARWIN_BG if pace == "background" else 0,
        )
    except (AttributeError, OSError):
        pass  # not macOS, or not allowed: the pace is a courtesy


def watch_parent():
    parent = os.getppid()
    while True:
        time.sleep(2)
        if os.getppid() != parent:
            os._exit(0)


threading.Thread(target=watch_parent, daemon=True).start()

try:
    import numpy as np
    import soundfile as sf
    import mlx.core as mx
    from mlx_audio.tts.utils import load_model
except Exception as e:  # noqa: BLE001
    say({"type": "fatal", "reason": "unavailable", "message": f"mlx-audio could not be loaded: {e}"})
    sys.exit(3)

try:
    mx.set_cache_limit(CACHE_LIMIT)
    model = load_model(MODEL)
    # British English phonemes, to match the British voices.
    pipeline = model._get_pipeline("b")
except Exception as e:  # noqa: BLE001
    say({"type": "fatal", "reason": "failed", "message": f"could not load {MODEL}: {e}"})
    sys.exit(4)


def speak(text):
    """One segment: its samples, and its words as offsets and seconds."""
    chunks = []
    words = []
    at = 0.0  # seconds into this segment
    cursor = 0  # characters into `text`
    for result in pipeline(text, voice=VOICE, speed=1.0, split_pattern=None):
        audio = np.array(result.audio).reshape(-1)
        for tk in result.tokens or []:
            if not WORD.search(tk.text or ""):
                continue
            found = text.find(tk.text, cursor)
            if found < 0:
                continue
            cursor = found + len(tk.text)
            if tk.start_ts is None or tk.end_ts is None:
                continue
            words.append(
                {
                    "from": found,
                    "to": cursor,
                    "start": at + tk.start_ts,
                    "end": at + tk.end_ts,
                }
            )
        chunks.append(audio)
        at += len(audio) / RATE
    samples = np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)
    return samples, words


def generate(segments, out, pace):
    set_pace(pace)
    parts = []
    timed = []
    t = 0.0
    for seg in segments:
        began = time.monotonic()
        samples, words = speak(seg["text"])
        if pace == "background":
            time.sleep((time.monotonic() - began) * REST)
        start = t
        t += len(samples) / RATE
        timed.append(
            {
                "id": seg["id"],
                "start": round(start, 3),
                "end": round(t, 3),
                "words": [
                    {
                        "from": w["from"],
                        "to": w["to"],
                        "start": round(start + w["start"], 3),
                        "end": round(start + w["end"], 3),
                    }
                    for w in words
                ],
            }
        )
        parts.append(samples.astype(np.float32))
        pause = float(seg.get("pauseAfter", 0))
        parts.append(np.zeros(int(round(pause * RATE)), dtype=np.float32))
        t += pause
    audio = np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)
    sf.write(
        out,
        np.clip(audio, -1, 1),
        RATE,
        format="MP3",
        subtype="MPEG_LAYER_III",
        bitrate_mode="CONSTANT",
        compression_level=MP3_COMPRESSION,
    )
    return {"type": "done", "duration": round(len(audio) / RATE, 3), "segments": timed}


# Warm the pipeline so the first real request is not the slow one.
speak("Ready.")
mx.clear_cache()
say({"type": "ready"})

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        request = json.loads(line)
        say(generate(request["segments"], request["out"], request.get("pace", "now")))
        mx.clear_cache()
    except Exception as e:  # noqa: BLE001
        say({"type": "error", "message": str(e) or type(e).__name__})
