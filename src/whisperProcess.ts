// ============================================================
// whisperProcess.ts — Faster-Whisper persistent subprocess
// PRD §2.3: length-prefixed PCM stdin, JSON-line stdout
// ============================================================

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as readline from 'readline';

// ── Types ─────────────────────────────────────────────────────

export type WhisperTranscriptEvent =
  | { type: 'partial'; text: string; ts: number }
  | { type: 'final'; text: string; duration_ms: number; ts: number }
  | { type: 'error'; code: string; msg: string };

export type WhisperTranscriptCallback = (event: WhisperTranscriptEvent) => void;

// ── Config ────────────────────────────────────────────────────

const PYTHON  = process.env.PYTHON_BIN ?? 'python3';
const SCRIPT  = path.join(process.cwd(), 'faster_whisper_server.py');
const RESTART_DELAY_MS = 500;

// ── Singleton state ───────────────────────────────────────────

let proc: ChildProcess | null      = null;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let transcriptCallback: WhisperTranscriptCallback | null = null;
let isStarted = false;
let discarding = false;  // set true on vad_misfire — ignore next EOF response

// ── Public API ────────────────────────────────────────────────

/**
 * Register a callback to receive transcript events.
 * Must be called before start().
 */
export function onWhisperEvent(cb: WhisperTranscriptCallback): void {
  transcriptCallback = cb;
}

/**
 * Start (or restart) the Faster-Whisper subprocess.
 * Safe to call multiple times — idempotent if already running.
 */
export function start(): void {
  if (proc && !proc.killed) {
    // Already running — reset discard flag
    discarding = false;
    return;
  }
  discarding = false;
  spawnWhisper();
}

/**
 * Write a PCM chunk to Whisper's stdin with a 4-byte length prefix.
 * PRD §2.3: [uint32 LE byte_count][int16 PCM bytes]
 */
export function writeChunk(pcmBuffer: Buffer): void {
  if (!proc || proc.stdin === null || proc.killed) {
    console.warn('[whisper] writeChunk called but process is not running');
    return;
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(pcmBuffer.length, 0);
  proc.stdin.write(Buffer.concat([header, pcmBuffer]));
}

/**
 * Signal end-of-utterance by sending a 4-byte zero sentinel.
 * Whisper will transcribe the accumulated audio and emit a "final" JSON line.
 */
export function sendEof(): void {
  if (!proc || proc.stdin === null || proc.killed) {
    console.warn('[whisper] sendEof called but process is not running');
    return;
  }
  const sentinel = Buffer.alloc(4, 0);
  proc.stdin.write(sentinel);
}

/**
 * Discard any pending audio — used when VAD misfire resets to IDLE.
 * Sets discard flag to ignore the next "final" response if one somehow arrives.
 */
export function discard(): void {
  discarding = true;
}

/**
 * Stop the subprocess permanently (server shutdown).
 */
export function stop(): void {
  isStarted = false;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  if (proc) { proc.kill('SIGTERM'); proc = null; }
}

// ── Internal ──────────────────────────────────────────────────

function spawnWhisper(): void {
  isStarted = true;
  console.log(`[whisper] Spawning subprocess: ${PYTHON} ${SCRIPT}`);

  proc = spawn(PYTHON, [SCRIPT], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      WHISPER_MODEL:     process.env.WHISPER_MODEL     ?? 'base.en',
      WHISPER_MODEL_DIR: process.env.WHISPER_MODEL_DIR ?? '/tmp/whisper_models',
      PYTHONUNBUFFERED:  '1',   // Force unbuffered stdout so JSON lines arrive immediately
    },
  });

  // Forward Python stderr to Node.js stderr
  proc.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[whisper|py] ${chunk.toString()}`);
  });

  // Parse newline-delimited JSON from stdout
  const rl = readline.createInterface({ input: proc.stdout!, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let event: WhisperTranscriptEvent;
    try {
      event = JSON.parse(trimmed) as WhisperTranscriptEvent;
    } catch {
      console.error(`[whisper] Unparseable stdout line: ${trimmed.slice(0, 120)}`);
      return;
    }

    // If we're discarding (vad_misfire), swallow this event
    if (discarding) {
      discarding = false;
      console.log('[whisper] Discarding transcript (vad_misfire)');
      return;
    }

    transcriptCallback?.(event);
  });

  proc.on('exit', (code, signal) => {
    console.warn(`[whisper] Process exited (code=${code} signal=${signal})`);
    proc = null;
    rl.close();

    if (!isStarted) return;  // deliberate stop()

    // Auto-restart after delay
    console.log(`[whisper] Restarting in ${RESTART_DELAY_MS}ms…`);
    restartTimer = setTimeout(() => {
      // Notify state machine of crash via callback before restarting
      transcriptCallback?.({ type: 'error', code: 'SUBPROCESS_CRASH', msg: 'Whisper process crashed and is restarting' });
      spawnWhisper();
    }, RESTART_DELAY_MS);
  });

  proc.on('error', (err) => {
    console.error(`[whisper] Spawn error: ${err.message}`);
    // 'exit' event will follow and handle restart
  });
}
