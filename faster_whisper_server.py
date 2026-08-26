#!/usr/bin/env python3
"""
faster_whisper_server.py — Persistent Whisper STT subprocess
==============================================================
PRD §2.3: Runs as a subprocess managed by Node.js.

stdin protocol  (length-prefixed PCM):
    [4-byte uint32 LE = byte_count][int16 PCM bytes]
    [4-byte uint32 LE = 0x00000000]  ← end-of-utterance sentinel

stdout protocol (newline-delimited JSON):
    {"type": "partial", "text": "...", "ts": 1234567890.123}
    {"type": "final",   "text": "...", "duration_ms": 145, "ts": 1234567890.456}
    {"type": "error",   "code": "DECODE_FAIL", "msg": "..."}

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

def log_err(msg):
    """Write to stderr so Node.js can forward to server logs."""
    print(f"[whisper] {msg}", file=sys.stderr, flush=True)

def emit(obj):
    """Write a newline-delimited JSON line to stdout."""
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

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

            if len(audio_chunks) % 20 == 0:
                # log_err(f"Buffered {len(audio_chunks)} frames...")
                emit({
                    "type": "partial",
                    "text": "...",
                    "ts": time.time(),
                })


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
            condition_on_previous_text=True,
        )

        # Collect all segments (generator) into final text
        full_text = " ".join(seg.text.strip() for seg in segments).strip()
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
