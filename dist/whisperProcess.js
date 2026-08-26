"use strict";
// ============================================================
// whisperProcess.ts — Faster-Whisper persistent subprocess
// PRD §2.3: length-prefixed PCM stdin, JSON-line stdout
// ============================================================
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.onWhisperEvent = onWhisperEvent;
exports.start = start;
exports.writeChunk = writeChunk;
exports.sendEof = sendEof;
exports.discard = discard;
exports.stop = stop;
const child_process_1 = require("child_process");
const path = __importStar(require("path"));
const readline = __importStar(require("readline"));
const RESTART_DELAY_MS = 500;
// ── Singleton state ───────────────────────────────────────────
let proc = null;
let restartTimer = null;
let transcriptCallback = null;
let isStarted = false;
let discarding = false; // set true on vad_misfire — ignore next EOF response
// ── Public API ────────────────────────────────────────────────
/**
 * Register a callback to receive transcript events.
 * Must be called before start().
 */
function onWhisperEvent(cb) {
    transcriptCallback = cb;
}
/**
 * Start (or restart) the Faster-Whisper subprocess.
 * Safe to call multiple times — idempotent if already running.
 */
function start() {
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
function writeChunk(pcmBuffer) {
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
function sendEof() {
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
function discard() {
    discarding = true;
}
/**
 * Stop the subprocess permanently (server shutdown).
 */
function stop() {
    isStarted = false;
    if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
    }
    if (proc) {
        proc.kill('SIGTERM');
        proc = null;
    }
}
// ── Internal ──────────────────────────────────────────────────
function spawnWhisper() {
    isStarted = true;
    const PYTHON = process.env.PYTHON_BIN ?? 'python3';
    const SCRIPT = path.join(process.cwd(), 'faster_whisper_server.py');
    console.log(`[whisper] Spawning subprocess: ${PYTHON} ${SCRIPT}`);
    proc = (0, child_process_1.spawn)(PYTHON, [SCRIPT], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
            ...process.env,
            WHISPER_MODEL: process.env.WHISPER_MODEL ?? 'base.en',
            WHISPER_MODEL_DIR: process.env.WHISPER_MODEL_DIR ?? '/tmp/whisper_models',
            PYTHONUNBUFFERED: '1', // Force unbuffered stdout so JSON lines arrive immediately
        },
    });
    // Forward Python stderr to Node.js stderr
    proc.stderr?.on('data', (chunk) => {
        process.stderr.write(`[whisper|py] ${chunk.toString()}`);
    });
    // Parse newline-delimited JSON from stdout
    const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed)
            return;
        let event;
        try {
            event = JSON.parse(trimmed);
        }
        catch {
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
        if (!isStarted)
            return; // deliberate stop()
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
//# sourceMappingURL=whisperProcess.js.map