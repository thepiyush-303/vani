#!/usr/bin/env python3
"""
vosk_server.py — Persistent Vosk streaming-STT subprocess (live captions)
=========================================================================
Companion to faster_whisper_server.py. Vosk produces REAL interim results
while the user is still speaking; Whisper produces the accurate final that
is sent to the LLM. Vosk output is display-only — never fed to the LLM.

stdin protocol  (length-prefixed PCM, identical framing to Whisper):
    [4-byte uint32 LE = byte_count][int16 PCM bytes]   ← feed audio, live
    [4-byte uint32 LE = 0x00000000]                    ← finalize utterance
    [4-byte uint32 LE = 0xFFFFFFFF]                    ← silent reset (no output)

stdout protocol (newline-delimited JSON):
    {"type": "partial", "text": "...", "ts": 1234567890.123}
    {"type": "final",   "text": "...", "ts": 1234567890.456}
    {"type": "error",   "code": "MODEL_MISSING", "msg": "..."}

stderr: debug/startup logs (Node.js forwards to console.error)
"""

import sys
import os
import json
import struct
import time

# ── Config ────────────────────────────────────────────────────────────────────

SAMPLE_RATE = 16000  # Hz — must match client capture rate

DEFAULT_MODEL_PATH = os.path.join("models", "vosk-model-small-en-us-0.15")
MODEL_PATH = os.environ.get("VOSK_MODEL_PATH", DEFAULT_MODEL_PATH)

# Vosk is most efficient on ~0.1s blocks. The client sends 512-sample (1024-byte)
# frames every ~32ms, so we coalesce them before handing audio to the recognizer.
# This also sets the granularity of partial emissions.
CHUNK_BYTES = int(os.environ.get("VOSK_CHUNK_BYTES", "4000"))

RESET_SENTINEL = 0xFFFFFFFF

DOWNLOAD_HINT = (
    "Download a model from https://alphacephei.com/vosk/models "
    "(vosk-model-small-en-us-0.15 recommended — 40MB), unzip it, and either place it at "
    f"'{DEFAULT_MODEL_PATH}' or set VOSK_MODEL_PATH to its directory."
)


def log_err(msg):
    """Write to stderr so Node.js can forward to server logs."""
    print(f"[vosk] {msg}", file=sys.stderr, flush=True)


def emit(obj):
    """Write a newline-delimited JSON line to stdout."""
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def fatal(code, msg):
    """Report an unrecoverable startup problem and exit."""
    log_err(f"ERROR: {msg}")
    emit({"type": "error", "code": code, "msg": msg})
    sys.exit(1)


# ── Load model at startup (once, persistent) ───────────────────────────────────

try:
    from vosk import Model, KaldiRecognizer, SetLogLevel
except ImportError:
    fatal("VOSK_NOT_INSTALLED", "vosk not installed. Run: pip install vosk")

SetLogLevel(-1)  # silence Kaldi's very chatty stderr output

if not os.path.isdir(MODEL_PATH):
    fatal("MODEL_MISSING", f"Vosk model directory not found: '{MODEL_PATH}'. {DOWNLOAD_HINT}")

log_err(f"Loading Vosk model: {MODEL_PATH} ...")
try:
    model = Model(MODEL_PATH)
except Exception as e:
    fatal("MODEL_LOAD_FAIL", f"Failed to load Vosk model from '{MODEL_PATH}': {e}")

log_err("Model loaded successfully.")


# ── Recognizer lifecycle ───────────────────────────────────────────────────────

class Stream:
    """
    One utterance's worth of streaming recognition state.

    Vosk finalizes internally whenever it detects an endpoint mid-utterance, so
    the full caption is `committed` (all finalized segments) + the live partial.
    """

    def __init__(self):
        self.rec = KaldiRecognizer(model, SAMPLE_RATE)
        self.committed = []     # finalized segment texts for this utterance
        self.pending = b""      # bytes not yet handed to the recognizer
        self.last_emitted = ""  # dedupe guard for partial emissions

    def caption(self, partial=""):
        return " ".join([*self.committed, partial]).strip()

    def feed(self, pcm_bytes):
        """Buffer audio, and run recognition once a full chunk is available."""
        self.pending += pcm_bytes
        while len(self.pending) >= CHUNK_BYTES:
            block, self.pending = self.pending[:CHUNK_BYTES], self.pending[CHUNK_BYTES:]
            self._recognize(block)

    def _recognize(self, block):
        if self.rec.AcceptWaveform(block):
            text = json.loads(self.rec.Result()).get("text", "").strip()
            if text:
                self.committed.append(text)
        partial = json.loads(self.rec.PartialResult()).get("partial", "").strip()
        self._emit_partial(self.caption(partial))

    def _emit_partial(self, caption):
        if not caption or caption == self.last_emitted:
            return
        self.last_emitted = caption
        emit({"type": "partial", "text": caption, "ts": time.time()})

    def finalize(self):
        """Flush residual audio, emit the utterance's final caption."""
        if self.pending:
            self._recognize(self.pending)
            self.pending = b""
        text = json.loads(self.rec.FinalResult()).get("text", "").strip()
        if text:
            self.committed.append(text)
        emit({"type": "final", "text": self.caption(), "ts": time.time()})


# ── Main read loop ─────────────────────────────────────────────────────────────

def read_stdin_loop():
    stdin_bin = sys.stdin.buffer
    stream = Stream()

    while True:
        header = stdin_bin.read(4)
        if len(header) < 4:
            log_err(f"stdin closed — exiting. (Got {len(header)} bytes)")
            break

        byte_count = struct.unpack("<I", header)[0]

        if byte_count == 0:
            # Finalize: emit the utterance's final caption, then start fresh.
            try:
                stream.finalize()
            except Exception as e:
                log_err(f"Finalize error: {e}")
                emit({"type": "error", "code": "DECODE_FAIL", "msg": str(e)})
            stream = Stream()
            continue

        if byte_count == RESET_SENTINEL:
            # Silent reset (new utterance / VAD misfire) — discard state, emit nothing.
            stream = Stream()
            continue

        pcm_bytes = stdin_bin.read(byte_count)
        if len(pcm_bytes) < byte_count:
            log_err(f"Truncated frame: expected {byte_count} bytes, got {len(pcm_bytes)}")
            break

        try:
            stream.feed(pcm_bytes)
        except Exception as e:
            log_err(f"Recognition error: {e}")
            emit({"type": "error", "code": "DECODE_FAIL", "msg": str(e)})
            stream = Stream()


if __name__ == "__main__":
    log_err(f"Vosk subprocess ready (chunk={CHUNK_BYTES}B) — waiting for PCM frames on stdin.")
    try:
        read_stdin_loop()
    except KeyboardInterrupt:
        log_err("Interrupted — exiting.")
    sys.exit(0)
