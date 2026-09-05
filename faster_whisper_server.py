#!/usr/bin/env python3
"""
faster_whisper_server.py — Persistent Whisper STT subprocess
==============================================================
PRD §2.3: Runs as a subprocess managed by Node.js.

stdin protocol  (length-prefixed PCM):
    [4-byte uint32 LE = byte_count][int16 PCM bytes]
    [4-byte uint32 LE = 0x00000000]  ← end-of-utterance sentinel

stdout protocol (newline-delimited JSON):
    {"type": "final",   "text": "...", "duration_ms": 145, "ts": 1234567890.456}
    {"type": "error",   "code": "DECODE_FAIL", "msg": "..."}

Whisper only emits finals — it cannot transcribe a partially-buffered utterance.
Live interim captions come from vosk_server.py.

stderr: debug/startup logs (Node.js forwards to console.error)
"""

import sys
import os
import json
import struct
import time
import io
import numpy as np

# ── Model setup ───────────────────────────────────────────────────────────────

WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "base.en")
DOWNLOAD_ROOT = os.environ.get("WHISPER_MODEL_DIR", "/tmp/whisper_models")
SAMPLE_RATE   = 16000  # Hz — must match client capture rate

# Domain vocabulary: names/jargon Whisper mishears. Supplied via VANI_VOCAB
# (comma-separated) and/or a vocab.txt file (one term per line, # for comments).
# Passed as initial_prompt so the decoder is primed with the correct spellings.
VOCAB_FILE = os.environ.get("VANI_VOCAB_FILE", "vocab.txt")
VOCAB_ENV  = os.environ.get("VANI_VOCAB", "")

def log_err(msg):
    """Write to stderr so Node.js can forward to server logs."""
    print(f"[whisper] {msg}", file=sys.stderr, flush=True)

def emit(obj):
    """Write a newline-delimited JSON line to stdout."""
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

# ── Vocabulary biasing ────────────────────────────────────────────────────────

def load_vocab_prompt():
    """
    Build the initial_prompt string from VANI_VOCAB and the vocab file.
    Returns None when no vocabulary is configured (keeps decoding unbiased).
    """
    terms = [t.strip() for t in VOCAB_ENV.split(",")]

    if os.path.isfile(VOCAB_FILE):
        try:
            with open(VOCAB_FILE, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.split("#", 1)[0].strip()
                    if line:
                        terms.append(line)
        except Exception as e:
            log_err(f"Could not read vocab file '{VOCAB_FILE}': {e}")

    # De-duplicate, preserve order, drop empties
    seen, unique = set(), []
    for t in terms:
        if t and t.lower() not in seen:
            seen.add(t.lower())
            unique.append(t)

    if not unique:
        return None

    # Whisper's initial_prompt is a text fragment, not a word list — phrasing it
    # as prose primes the decoder far better than bare comma-separated tokens.
    # Keep it short: a long prompt costs decode time and can bleed into output.
    prompt = "Glossary: " + ", ".join(unique) + "."
    log_err(f"Vocabulary biasing enabled ({len(unique)} terms).")
    return prompt


VOCAB_PROMPT = load_vocab_prompt()

# ── Load model at startup (once, persistent) ──────────────────────────────────

log_err(f"Loading Faster-Whisper model: {WHISPER_MODEL} (compute_type=int8, device=cpu)...")
try:
    from faster_whisper import WhisperModel
    model = WhisperModel(
        model_size_or_path=WHISPER_MODEL,
        device="cpu",
        compute_type="int8",       # MANDATORY for CPU — halves RAM usage
        num_workers=2,
        download_root=DOWNLOAD_ROOT,
    )
    log_err(f"Model loaded successfully.")
except ImportError:
    log_err("ERROR: faster-whisper not installed. Run: pip install faster-whisper")
    sys.exit(1)
except Exception as e:
    log_err(f"ERROR loading model: {e}")
    sys.exit(1)

# ── Main read loop ─────────────────────────────────────────────────────────────

def read_stdin_loop():
    """
    Reads length-prefixed PCM frames from stdin in a tight loop.
    Accumulates frames until a zero-length sentinel is received,
    then transcribes the complete utterance.
    """
    stdin_bin = sys.stdin.buffer
    audio_chunks = []

    while True:
        # Read exactly 4 bytes for the frame length header
        header = stdin_bin.read(4)
        if len(header) < 4:
            log_err(f"stdin closed — exiting. (Got {len(header)} bytes)")
            break

        byte_count = struct.unpack("<I", header)[0]
        # log_err(f"Read header: byte_count={byte_count}")

        if byte_count == 0:
            log_err(f"Received EOF sentinel. Buffered chunks: {len(audio_chunks)}")
            if not audio_chunks:
                log_err("Received EOF sentinel but no audio buffered — ignoring.")
                continue

            raw_pcm = b"".join(audio_chunks)
            audio_chunks = []
            
            log_err(f"Starting transcribe on {len(raw_pcm)} bytes PCM...")
            int16_array = np.frombuffer(raw_pcm, dtype=np.int16)
            float32_audio = int16_array.astype(np.float32) / 32768.0

            utterance_start = time.time()
            transcribe(float32_audio, utterance_start)
            log_err("Finished transcribe function")

        else:
            pcm_bytes = stdin_bin.read(byte_count)
            if len(pcm_bytes) < byte_count:
                log_err(f"Truncated frame: expected {byte_count} bytes, got {len(pcm_bytes)}")
                break
            audio_chunks.append(pcm_bytes)
            # No partials here: Whisper cannot produce interim results for a
            # partially-buffered utterance. Live captions come from vosk_server.py.


def transcribe(float32_audio: np.ndarray, utterance_start: float):
    """Run Faster-Whisper on the buffered utterance and emit JSON results."""
    try:
        t0 = time.time()

        segments, info = model.transcribe(
            float32_audio,
            language="en",
            beam_size=1,               # Greedy decoding — fastest
            vad_filter=False,          # VAD handled client-side (PRD §2.2)
            word_timestamps=False,
            condition_on_previous_text=False,  # each utterance is independent; skip cross-utterance context (faster, no hallucinated carry-over)
            initial_prompt=VOCAB_PROMPT,       # domain vocabulary biasing (None when unconfigured)
        )

        # Collect all segments (generator) into final text
        full_text = " ".join(seg.text.strip() for seg in segments).strip()

        # On near-silent audio Whisper sometimes parrots the initial_prompt back.
        # Never let the glossary reach the LLM as if the user had said it.
        if VOCAB_PROMPT and full_text.lower().startswith("glossary:"):
            log_err("Discarded transcription that echoed the vocabulary prompt.")
            full_text = ""

        duration_ms = int((time.time() - t0) * 1000)

        if not full_text:
            log_err("Transcription produced empty result — emitting empty final.")

        emit({
            "type": "final",
            "text": full_text,
            "duration_ms": duration_ms,
            "ts": time.time(),
        })

        log_err(f"Transcribed in {duration_ms}ms: \"{full_text[:80]}\"")

    except Exception as e:
        log_err(f"Transcription error: {e}")
        emit({
            "type": "error",
            "code": "DECODE_FAIL",
            "msg": str(e),
        })


if __name__ == "__main__":
    log_err("Whisper subprocess ready — waiting for PCM frames on stdin.")
    try:
        read_stdin_loop()
    except KeyboardInterrupt:
        log_err("Interrupted — exiting.")
    sys.exit(0)
