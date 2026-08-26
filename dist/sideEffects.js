"use strict";
// ============================================================
// sideEffects.ts — Side effect dispatcher
// Phase 4: Groq LLM streaming replaces Phase 3 stubs.
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.setInternalEventEmitter = setInternalEventEmitter;
exports.getActiveWs = getActiveWs;
exports.initSubprocesses = initSubprocesses;
exports.dispatchSideEffects = dispatchSideEffects;
exports.sendJson = sendJson;
exports.emitStateChange = emitStateChange;
const ws_1 = __importDefault(require("ws"));
const whisperProcess = __importStar(require("./whisperProcess"));
const piperProcess = __importStar(require("./piperProcess"));
const sentenceBuffer_1 = require("./sentenceBuffer");
const groqStream_1 = require("./groqStream");
const sharedState_1 = require("./sharedState");
// ── Sentence buffer & internal event callback ─────────────────
let sentenceBuffer = null;
let activeWs = null;
// Set by server.ts so Groq callbacks can fire handleInternalEvent
let internalEventEmitter = null;
function setInternalEventEmitter(emitter) {
    internalEventEmitter = emitter;
}
function getActiveWs() { return activeWs; }
function getSentenceBuffer(ws) {
    if (!sentenceBuffer) {
        sentenceBuffer = new sentenceBuffer_1.SentenceBuffer((sentence) => {
            piperProcess.synthesize(sentence, ws);
        });
    }
    return sentenceBuffer;
}
function resetSentenceBuffer() {
    sentenceBuffer?.reset();
    sentenceBuffer = null;
}
// ── Public: register Whisper + Piper at server startup ────────
/**
 * Called once at server startup to spawn subprocesses and wire
 * Whisper transcript events into the state machine.
 * @param emitInternalEvent  Callback into messageHandler/server to fire internal events
 */
function initSubprocesses(emitInternalEvent) {
    // Store so Groq callback can also fire internal events
    internalEventEmitter = emitInternalEvent;
    // Wire Whisper transcript events → internal state machine events
    whisperProcess.onWhisperEvent((ev) => {
        switch (ev.type) {
            case 'partial':
                emitInternalEvent('whisper_partial', { text: ev.text });
                break;
            case 'final':
                emitInternalEvent('whisper_final', { text: ev.text, duration_ms: ev.duration_ms });
                break;
            case 'error':
                emitInternalEvent('whisper_error', { code: ev.code, msg: ev.msg });
                break;
        }
    });
    // Start Whisper subprocess
    whisperProcess.start();
    // Start Piper subprocess (optional — warns if model not configured)
    piperProcess.start();
}
function dispatchSideEffects(effects, { ws, ctx }) {
    activeWs = ws;
    for (const effect of effects) {
        switch (effect) {
            case 'OPEN_WHISPER_PIPE':
                openWhisperPipe(ctx);
                break;
            case 'SEND_EOF_TO_WHISPER':
                sendEofToWhisper(ctx);
                break;
            case 'DISCARD_WHISPER_BUFFER':
                discardWhisperBuffer(ctx);
                break;
            case 'START_GROQ_STREAM':
                triggerGroqStream(ctx);
                break;
            case 'ABORT_GROQ_STREAM':
                triggerAbortGroq(ctx);
                break;
            case 'SPAWN_PIPER':
                spawnPiper(ws, ctx);
                break;
            case 'KILL_PIPER':
                killPiper(ws, ctx);
                break;
            case 'SEND_FILLER_TTS':
                sendFillerTts(ws, ctx);
                break;
            case 'SEND_TURN_COMPLETE':
                sendTurnComplete(ws, ctx);
                break;
            case 'NOTIFY_CLIENT_ERROR':
                notifyClientError(ws, ctx);
                break;
            case 'NOOP':
                break;
        }
    }
}
// ── Real Whisper side-effects ──────────────────────────────────
function openWhisperPipe(ctx) {
    ctx.audioBuffer = [];
    whisperProcess.start(); // idempotent — no-op if already running
    console.log(`[${ctx.sessionId}] OPEN_WHISPER_PIPE — audio buffer cleared, Whisper ready`);
}
function sendEofToWhisper(ctx) {
    const frameCount = ctx.audioBuffer.length;
    const byteCount = ctx.audioBuffer.reduce((s, b) => s + b.length, 0);
    console.log(`[${ctx.sessionId}] SEND_EOF_TO_WHISPER — flushing ${frameCount} frames (${byteCount} bytes)`);
    // Write all buffered PCM frames to Whisper stdin
    for (const chunk of ctx.audioBuffer) {
        whisperProcess.writeChunk(chunk);
    }
    ctx.audioBuffer = [];
    // Send end-of-utterance sentinel
    whisperProcess.sendEof();
}
function discardWhisperBuffer(ctx) {
    console.log(`[${ctx.sessionId}] DISCARD_WHISPER_BUFFER — dropping ${ctx.audioBuffer.length} frames`);
    ctx.audioBuffer = [];
    whisperProcess.discard();
}
// ── Real Piper side-effects ────────────────────────────────────
function spawnPiper(ws, ctx) {
    const buf = new sentenceBuffer_1.SentenceBuffer((sentence) => {
        piperProcess.synthesize(sentence, ws);
    });
    sentenceBuffer = buf;
    (0, sharedState_1.setActiveSentenceBuffer)(buf); // share with messageHandler llm_token handler
    console.log(`[${ctx.sessionId}] SPAWN_PIPER — sentence buffer active`);
}
function killPiper(ws, ctx) {
    console.log(`[${ctx.sessionId}] KILL_PIPER — barge-in flush`);
    resetSentenceBuffer();
    (0, sharedState_1.setActiveSentenceBuffer)(null); // clear messageHandler reference
    piperProcess.kill();
    const msg = {
        type: 'tts_interrupted',
        session_id: ctx.sessionId,
        reason: 'barge_in',
        timestamp_ms: Date.now(),
    };
    sendJson(ws, msg);
}
function sendFillerTts(ws, ctx) {
    console.log(`[${ctx.sessionId}] SEND_FILLER_TTS`);
    piperProcess.sendFillerPhrase(ws);
}
// ── Groq LLM side-effects ─────────────────────────────────────
function triggerGroqStream(ctx) {
    if (!internalEventEmitter) {
        console.warn(`[${ctx.sessionId}] START_GROQ_STREAM: internalEventEmitter not set`);
        return;
    }
    const emit = internalEventEmitter;
    // Fire-and-forget (async stream runs in background)
    (0, groqStream_1.startGroqStream)(ctx, (ev) => {
        switch (ev.type) {
            case 'llm_token':
                emit('llm_token', { delta: ev.delta, tokenIndex: ev.tokenIndex });
                break;
            case 'llm_tool_call':
                emit('llm_tool_call', { name: ev.name, args: ev.args });
                break;
            case 'llm_stream_complete':
                emit('llm_stream_complete', { fullText: ev.fullText });
                break;
            case 'llm_error':
                console.error(`[groq] Error ${ev.code}: ${ev.msg}`);
                emit('llm_error', { code: ev.code, msg: ev.msg }); // reset to IDLE + surface real error
                break;
        }
    }).catch((err) => {
        console.error(`[groq] Unhandled stream error: ${err}`);
        emit('llm_error', { code: 'GROQ_FATAL', msg: String(err) });
    });
    console.log(`[${ctx.sessionId}] START_GROQ_STREAM — Groq stream initiated`);
}
function triggerAbortGroq(ctx) {
    console.log(`[${ctx.sessionId}] ABORT_GROQ_STREAM — aborting Groq stream`);
    (0, groqStream_1.abortGroqStream)();
}
// ── Completion & error messages ───────────────────────────────
function sendTurnComplete(ws, ctx) {
    const latency = ctx.turnStartedAt !== null
        ? Date.now() - ctx.turnStartedAt
        : -1;
    const msg = {
        type: 'turn_complete',
        session_id: ctx.sessionId,
        total_latency_ms: latency,
        token_count: ctx.tokenCount,
        timestamp_ms: Date.now(),
    };
    sendJson(ws, msg);
    ctx.turnStartedAt = null;
    ctx.tokenCount = 0;
    // Do NOT kill Piper here. It is a persistent --json-input daemon that is
    // still synthesizing the sentences we just queued; SIGTERM would cut the
    // audio before any PCM is produced (the turn "completes" the instant the LLM
    // stream ends, long before TTS playback finishes). Piper is only terminated
    // on barge-in (KILL_PIPER) or server shutdown (stop()); between turns it idles.
    resetSentenceBuffer();
    (0, sharedState_1.setActiveSentenceBuffer)(null); // clear messageHandler reference
    console.log(`[${ctx.sessionId}] turn_complete (latency=${latency}ms)`);
}
function notifyClientError(ws, ctx) {
    // If a specific error was stashed (e.g. an LLM/Groq failure), surface the
    // real code+message; otherwise default to the STT failure message.
    const pending = ctx.pendingError;
    const msg = {
        type: 'error',
        session_id: ctx.sessionId,
        code: pending?.code ?? 'STT_FAIL',
        message: pending?.message ?? 'Speech transcription failed. Please try again.',
        recoverable: true,
        timestamp_ms: Date.now(),
    };
    sendJson(ws, msg);
    ctx.pendingError = undefined;
    console.error(`[${ctx.sessionId}] Error sent to client: ${msg.code} — ${msg.message}`);
}
// ── WS helpers ─────────────────────────────────────────────────
function sendJson(ws, msg) {
    if (ws.readyState === ws_1.default.OPEN) {
        ws.send(JSON.stringify(msg));
    }
}
function emitStateChange(ws, from, to) {
    if (from === to)
        return;
    const msg = {
        type: 'state_change',
        from,
        to,
        timestamp_ms: Date.now(),
    };
    sendJson(ws, msg);
    console.log(`[state] ${from} → ${to}`);
}
//# sourceMappingURL=sideEffects.js.map