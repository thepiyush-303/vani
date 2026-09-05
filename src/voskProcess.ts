// ============================================================
// voskProcess.ts — Vosk streaming-STT persistent subprocess
// Produces REAL interim captions while the user is still speaking.
// Display-only: Whisper still produces the final sent to the LLM.
// Same stdin framing as whisperProcess, plus a silent-reset sentinel.
// ============================================================

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as readline from 'readline';

// ── Types ─────────────────────────────────────────────────────

export type VoskTranscriptEvent =
  | { type: 'partial'; text: string; ts: number }
  | { type: 'final'; text: string; ts: number }
  | { type: 'error'; code: string; msg: string };

export type VoskTranscriptCallback = (event: VoskTranscriptEvent) => void;

const RESTART_DELAY_MS = 500;

// A model-less or broken install exits immediately. Restarting forever would
// spam the logs and burn CPU, so give up after a few fast failures and let the
// pipeline run without live captions (Whisper finals are unaffected).
const FAST_FAILURE_MS = 3_000;
const MAX_FAST_FAILURES = 3;

// ── Singleton state ───────────────────────────────────────────

let proc: ChildProcess | null = null;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let transcriptCallback: VoskTranscriptCallback | null = null;
let isStarted = false;
let disabled = false;          // true once we stop trying to respawn
let spawnedAt = 0;
let fastFailures = 0;

// ── Public API ────────────────────────────────────────────────

/**
 * Register a callback to receive live transcript events.
 * Must be called before start().
 */
export function onVoskEvent(cb: VoskTranscriptCallback): void {
  transcriptCallback = cb;
}

/**
 * Start the Vosk subprocess. Idempotent; a no-op once disabled.
 */
export function start(): void {
  if (disabled) return;
  if (proc && !proc.killed) return;
  spawnVosk();
}

/** True when live captions are available. */
export function isAvailable(): boolean {
  return !disabled && proc !== null && !proc.killed;
}

/**
 * Feed a PCM frame for immediate recognition.
 * Silent when unavailable — this runs per audio frame, so it must not log.
 */
export function writeChunk(pcmBuffer: Buffer): void {
  if (!proc || proc.stdin === null || proc.killed) return;
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(pcmBuffer.length, 0);
  proc.stdin.write(Buffer.concat([header, pcmBuffer]));
}

/**
 * End of utterance: Vosk flushes and emits one "final" caption.
 */
export function finalizeUtterance(): void {
  writeSentinel(0);
}

/**
 * Drop recognizer state without emitting anything.
 * Used when a new utterance opens or a VAD misfire discards the last one.
 */
export function resetSilent(): void {
  writeSentinel(0xFFFFFFFF);
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

function writeSentinel(value: number): void {
  if (!proc || proc.stdin === null || proc.killed) return;
  const sentinel = Buffer.allocUnsafe(4);
  sentinel.writeUInt32LE(value, 0);
  proc.stdin.write(sentinel);
}

function spawnVosk(): void {
  isStarted = true;
  spawnedAt = Date.now();
  const PYTHON = process.env.PYTHON_BIN ?? 'python3';
  const SCRIPT = path.join(process.cwd(), 'vosk_server.py');

  console.log(`[vosk] Spawning subprocess: ${PYTHON} ${SCRIPT}`);

  proc = spawn(PYTHON, [SCRIPT], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',   // JSON lines must arrive immediately
    },
  });

  proc.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[vosk|py] ${chunk.toString()}`);
  });

  const rl = readline.createInterface({ input: proc.stdout!, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let event: VoskTranscriptEvent;
    try {
      event = JSON.parse(trimmed) as VoskTranscriptEvent;
    } catch {
      console.error(`[vosk] Unparseable stdout line: ${trimmed.slice(0, 120)}`);
      return;
    }

    transcriptCallback?.(event);
  });

  proc.on('exit', (code, signal) => {
    const uptime = Date.now() - spawnedAt;
    console.warn(`[vosk] Process exited (code=${code} signal=${signal} uptime=${uptime}ms)`);
    proc = null;
    rl.close();

    if (!isStarted) return;  // deliberate stop()

    fastFailures = uptime < FAST_FAILURE_MS ? fastFailures + 1 : 0;

    if (fastFailures >= MAX_FAST_FAILURES) {
      disabled = true;
      isStarted = false;
      console.error(
        '[vosk] Disabled after repeated immediate exits — live captions are off. ' +
        'Check the [vosk|py] logs above (most likely a missing model or `pip install vosk`). ' +
        'Whisper transcription is unaffected.',
      );
      return;
    }

    console.log(`[vosk] Restarting in ${RESTART_DELAY_MS}ms…`);
    restartTimer = setTimeout(spawnVosk, RESTART_DELAY_MS);
  });

  proc.on('error', (err) => {
    console.error(`[vosk] Spawn error: ${err.message}`);
    // 'exit' follows and handles restart/disable
  });
}
