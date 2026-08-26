"use strict";
// ============================================================
// piperProcess.ts — Piper TTS persistent subprocess
// PRD §2.4: JSON-line stdin, raw 16-bit PCM stdout at 22050Hz
// ============================================================
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.start = start;
exports.synthesize = synthesize;
exports.sendFillerPhrase = sendFillerPhrase;
exports.kill = kill;
exports.stop = stop;
const child_process_1 = require("child_process");
const ws_1 = __importDefault(require("ws"));
// ── Config ────────────────────────────────────────────────────
const PIPER_BINARY = process.env.PIPER_BINARY ?? 'piper';
const PIPER_MODEL_PATH = process.env.PIPER_MODEL_PATH ?? '';
const PIPER_CONFIG_PATH = process.env.PIPER_CONFIG_PATH ?? '';
const RESTART_DELAY_MS = 500;
// PRD §2.4: chunk Piper stdout into 4KB frames for WS streaming
const WS_CHUNK_BYTES = 4096;
// With a persistent (--json-input) Piper, stdout never 'end's between
// utterances, so the final sub-WS_CHUNK_BYTES fragment is flushed once stdout
// has been quiet for this long.
const IDLE_FLUSH_MS = 200;
// Framing header bytes prepended to every binary WS frame for client-side detection
// PRD §3.3.2: [0xAF][0xFE][uint16 LE sequence]
let frameSeq = 0;
// ── Singleton state ───────────────────────────────────────────
let proc = null;
let isStarted = false;
let isEnabled = false; // false if PIPER_MODEL_PATH not configured
let restartTimer = null;
// ── Public API ────────────────────────────────────────────────
/**
 * Initialize Piper. Returns false if model path is not configured.
 * Call at server startup; must be called before synthesize().
 */
function start() {
    if (!PIPER_MODEL_PATH) {
        console.warn('[piper] PIPER_MODEL_PATH not set — TTS disabled. Set it in .env to enable.');
        isEnabled = false;
        return false;
    }
    isEnabled = true;
    if (proc && !proc.killed)
        return true; // already running
    spawnPiper();
    return true;
}
/**
 * Send a sentence to Piper for synthesis.
 * Piper receives JSON-line: {"text": "..."}\n
 * Its stdout (raw PCM) is streamed back to the provided WebSocket.
 */
function synthesize(text, ws) {
    if (!isEnabled) {
        console.warn('[piper] synthesize() called but Piper is disabled');
        return;
    }
    if (!proc || proc.stdin === null || proc.killed) {
        console.warn('[piper] synthesize() called but process is not running');
        return;
    }
    const json = JSON.stringify({ text }) + '\n';
    proc.stdin.write(json);
    // Wire stdout → WS binary frames for this synthesis call.
    // Note: piperProcess uses a single persistent PCM stdout stream.
    // We register a one-shot data listener that drains all pending stdout into WS frames.
    // The actual chunk dispatch is handled by the persistent stdout listener in spawnPiper().
    setActiveSocket(ws);
    console.log(`[piper] Synthesizing: "${text.slice(0, 60)}..."`);
}
/**
 * Synthesize the standard filler phrase for tool execution wait.
 * PRD §5.1: played immediately when server enters TOOL_EXECUTING state.
 */
function sendFillerPhrase(ws) {
    synthesize('One moment please.', ws);
}
/**
 * Kill the Piper subprocess immediately.
 * Used for barge-in (PRD §5.2): must complete within 50ms.
 * The process will auto-restart after RESTART_DELAY_MS.
 */
function kill() {
    if (proc && !proc.killed) {
        console.log('[piper] Killing subprocess (barge-in)');
        proc.kill('SIGTERM');
        proc = null;
    }
    frameSeq = 0; // reset frame sequence counter
    clearActiveSocket();
}
/**
 * Stop Piper permanently (server shutdown).
 */
function stop() {
    isStarted = false;
    if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
    }
    if (idleFlushTimer) {
        clearTimeout(idleFlushTimer);
        idleFlushTimer = null;
    }
    if (proc) {
        proc.kill('SIGTERM');
        proc = null;
    }
}
// ── Active WebSocket tracking ─────────────────────────────────
// Piper writes to whoever requested the synthesis most recently.
let activeSocket = null;
let pcmBuffer = Buffer.alloc(0); // accumulate stdout until we have a full WS_CHUNK_BYTES
let idleFlushTimer = null; // flushes the tail once stdout goes quiet
function setActiveSocket(ws) {
    activeSocket = ws;
}
function clearActiveSocket() {
    activeSocket = null;
    pcmBuffer = Buffer.alloc(0);
    if (idleFlushTimer) {
        clearTimeout(idleFlushTimer);
        idleFlushTimer = null;
    }
}
/**
 * Build a framed binary WS message:
 * [0xAF][0xFE][uint16 LE seqNum][raw PCM bytes]
 */
function buildFrame(pcmChunk) {
    const header = Buffer.allocUnsafe(4);
    header[0] = 0xAF;
    header[1] = 0xFE;
    header.writeUInt16LE(frameSeq & 0xFFFF, 2);
    frameSeq = (frameSeq + 1) & 0xFFFF;
    return Buffer.concat([header, pcmChunk]);
}
function sendPcmChunk(chunk) {
    if (!activeSocket || activeSocket.readyState !== ws_1.default.OPEN)
        return;
    // Accumulate into buffer; emit complete WS_CHUNK_BYTES-sized frames
    pcmBuffer = Buffer.concat([pcmBuffer, chunk]);
    while (pcmBuffer.length >= WS_CHUNK_BYTES) {
        const frame = buildFrame(pcmBuffer.subarray(0, WS_CHUNK_BYTES));
        activeSocket.send(frame);
        pcmBuffer = pcmBuffer.subarray(WS_CHUNK_BYTES);
    }
}
function flushPcmBuffer() {
    // Send any remaining bytes at end of synthesis
    if (pcmBuffer.length > 0 && activeSocket && activeSocket.readyState === ws_1.default.OPEN) {
        const frame = buildFrame(pcmBuffer);
        activeSocket.send(frame);
        pcmBuffer = Buffer.alloc(0);
    }
}
/**
 * Flush the residual PCM tail once Piper's stdout has been quiet for
 * IDLE_FLUSH_MS. Needed because the persistent Piper never closes stdout
 * between utterances, so the final sub-WS_CHUNK_BYTES fragment would otherwise
 * sit in pcmBuffer and bleed into the next turn's audio.
 */
function scheduleIdleFlush() {
    if (idleFlushTimer)
        clearTimeout(idleFlushTimer);
    idleFlushTimer = setTimeout(() => {
        idleFlushTimer = null;
        flushPcmBuffer();
    }, IDLE_FLUSH_MS);
}
// ── Internal ──────────────────────────────────────────────────
function spawnPiper() {
    isStarted = true;
    const args = [
        '--model', PIPER_MODEL_PATH,
        '--output-raw', // stdout = raw PCM (no WAV header)
        '--sentence-silence', '0.1',
        '--json-input', // stdin = {"text": "..."}\n per line
    ];
    if (PIPER_CONFIG_PATH) {
        args.unshift('--config', PIPER_CONFIG_PATH);
    }
    console.log(`[piper] Spawning: ${PIPER_BINARY} ${args.join(' ')}`);
    proc = (0, child_process_1.spawn)(PIPER_BINARY, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Forward Piper stderr to Node.js stderr for diagnostic visibility
    proc.stderr?.on('data', (chunk) => {
        process.stderr.write(`[piper|bin] ${chunk.toString()}`);
    });
    // Stream stdout PCM → active WebSocket in chunked binary frames.
    // Reset the idle-flush timer on each chunk so the tail is flushed only once
    // synthesis for this utterance has actually stopped.
    proc.stdout?.on('data', (chunk) => {
        sendPcmChunk(chunk);
        scheduleIdleFlush();
    });
    proc.stdout?.on('end', () => {
        // Piper closed stdout (end of synthesis or process exit)
        flushPcmBuffer();
    });
    proc.on('exit', (code, signal) => {
        console.warn(`[piper] Process exited (code=${code} signal=${signal})`);
        proc = null;
        clearActiveSocket();
        if (!isStarted || !isEnabled)
            return;
        // Auto-restart unless kill() was called deliberately for barge-in
        restartTimer = setTimeout(() => {
            console.log('[piper] Restarting after crash…');
            spawnPiper();
        }, RESTART_DELAY_MS);
    });
    proc.on('error', (err) => {
        console.error(`[piper] Spawn error: ${err.message}`);
        if (err.message.includes('ENOENT')) {
            console.error('[piper] !! Piper binary not found. Install piper and set PIPER_BINARY in .env');
            isEnabled = false; // Don't keep retrying missing binary
        }
    });
}
//# sourceMappingURL=piperProcess.js.map