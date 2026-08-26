// ============================================================
// sideEffects.ts — Side effect dispatcher
// Phase 4: Groq LLM streaming replaces Phase 3 stubs.
// ============================================================

import WebSocket from 'ws';
import { SideEffectName, SessionContext, ServerMessage, ServerState, IncomingEventType } from './types';
import * as whisperProcess from './whisperProcess';
import * as piperProcess from './piperProcess';
import { SentenceBuffer } from './sentenceBuffer';
import { startGroqStream, abortGroqStream } from './groqStream';
import { setActiveSentenceBuffer } from './sharedState';
import { executeWeatherTool } from './tools/weather';

// ── Sentence buffer & internal event callback ─────────────────

let sentenceBuffer: SentenceBuffer | null = null;
let activeWs: WebSocket | null = null;

// Set by server.ts so Groq callbacks can fire handleInternalEvent
let internalEventEmitter: ((event: IncomingEventType, payload?: unknown) => void) | null = null;

export function setInternalEventEmitter(
  emitter: (event: IncomingEventType, payload?: unknown) => void
): void {
  internalEventEmitter = emitter;
}

export function getActiveWs(): WebSocket | null { return activeWs; }

function getSentenceBuffer(ws: WebSocket): SentenceBuffer {
  if (!sentenceBuffer) {
    sentenceBuffer = new SentenceBuffer((sentence) => {
      piperProcess.synthesize(sentence, ws);
    });
  }
  return sentenceBuffer;
}

function resetSentenceBuffer(): void {
  sentenceBuffer?.reset();
  sentenceBuffer = null;
}

// ── Public: register Whisper + Piper at server startup ────────

/**
 * Called once at server startup to spawn subprocesses and wire
 * Whisper transcript events into the state machine.
 * @param emitInternalEvent  Callback into messageHandler/server to fire internal events
 */
export function initSubprocesses(
  emitInternalEvent: (event: IncomingEventType, payload?: unknown) => void
): void {
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

// ── Dispatcher ─────────────────────────────────────────────────

export interface SideEffectContext {
  ws: WebSocket;
  ctx: SessionContext;
}

export function dispatchSideEffects(
  effects: SideEffectName[],
  { ws, ctx }: SideEffectContext,
): void {
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
      case 'EXECUTE_TOOL':
        executeTool(ws, ctx);
        break;
      case 'NOOP':
        break;
    }
  }
}

// ── Real Whisper side-effects ──────────────────────────────────

function openWhisperPipe(ctx: SessionContext): void {
  ctx.audioBuffer = [];
  whisperProcess.start(); // idempotent — no-op if already running
  console.log(`[${ctx.sessionId}] OPEN_WHISPER_PIPE — audio buffer cleared, Whisper ready`);
}

function sendEofToWhisper(ctx: SessionContext): void {
  const frameCount = ctx.audioBuffer.length;
  const byteCount  = ctx.audioBuffer.reduce((s, b) => s + b.length, 0);
  console.log(`[${ctx.sessionId}] SEND_EOF_TO_WHISPER — flushing ${frameCount} frames (${byteCount} bytes)`);

  // Write all buffered PCM frames to Whisper stdin
  for (const chunk of ctx.audioBuffer) {
    whisperProcess.writeChunk(chunk);
  }
  ctx.audioBuffer = [];

  // Send end-of-utterance sentinel
  whisperProcess.sendEof();
}

function discardWhisperBuffer(ctx: SessionContext): void {
  console.log(`[${ctx.sessionId}] DISCARD_WHISPER_BUFFER — dropping ${ctx.audioBuffer.length} frames`);
  ctx.audioBuffer = [];
  whisperProcess.discard();
}

// ── Real Piper side-effects ────────────────────────────────────

function spawnPiper(ws: WebSocket, ctx: SessionContext): void {
  const buf = new SentenceBuffer((sentence) => {
    piperProcess.synthesize(sentence, ws);
  });
  sentenceBuffer = buf;
  setActiveSentenceBuffer(buf);   // share with messageHandler llm_token handler
  console.log(`[${ctx.sessionId}] SPAWN_PIPER — sentence buffer active`);
}

function killPiper(ws: WebSocket, ctx: SessionContext): void {
  console.log(`[${ctx.sessionId}] KILL_PIPER — barge-in flush`);
  resetSentenceBuffer();
  setActiveSentenceBuffer(null);   // clear messageHandler reference
  piperProcess.kill();

  const msg: ServerMessage = {
    type: 'tts_interrupted',
    session_id: ctx.sessionId,
    reason: 'barge_in',
    timestamp_ms: Date.now(),
  };
  sendJson(ws, msg);
}

function sendFillerTts(ws: WebSocket, ctx: SessionContext): void {
  console.log(`[${ctx.sessionId}] SEND_FILLER_TTS`);
  piperProcess.sendFillerPhrase(ws);
}

function executeTool(ws: WebSocket, ctx: SessionContext): void {
  const tool = ctx.pendingToolCall;
  if (!tool) {
    console.warn(`[${ctx.sessionId}] EXECUTE_TOOL but no pendingToolCall found`);
    return;
  }
  ctx.pendingToolCall = undefined;
  
  const emit = internalEventEmitter;
  if (!emit) return;
  
  console.log(`[${ctx.sessionId}] EXECUTE_TOOL: ${tool.name}(${tool.args})`);
  
  // In a real app we'd dispatch to a registry. Here we just hardcode weather.
  if (tool.name === 'get_weather') {
    executeWeatherTool(tool.args).then(result => {
        // Append result to history
        ctx.conversationHistory.push({
            role: 'tool',
            content: result,
            tool_call_id: tool.id,
        });
        emit('tool_result_ready');
    }).catch(err => {
        console.error(`[${ctx.sessionId}] Tool execution failed:`, err);
        ctx.conversationHistory.push({
            role: 'tool',
            content: JSON.stringify({ error: "Tool execution failed locally" }),
            tool_call_id: tool.id,
        });
        emit('tool_result_ready');
    });
  } else {
    // Unrecognized tool
    ctx.conversationHistory.push({
        role: 'tool',
        content: JSON.stringify({ error: `Tool ${tool.name} is not implemented` }),
        tool_call_id: tool.id,
    });
    emit('tool_result_ready');
  }
}

// ── Groq LLM side-effects ─────────────────────────────────────

function triggerGroqStream(ctx: SessionContext): void {
  if (!internalEventEmitter) {
    console.warn(`[${ctx.sessionId}] START_GROQ_STREAM: internalEventEmitter not set`);
    return;
  }

  const emit = internalEventEmitter;

  // Fire-and-forget (async stream runs in background)
  startGroqStream(ctx, (ev) => {
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

function triggerAbortGroq(ctx: SessionContext): void {
  console.log(`[${ctx.sessionId}] ABORT_GROQ_STREAM — aborting Groq stream`);
  abortGroqStream();
}

// ── Completion & error messages ───────────────────────────────

function sendTurnComplete(ws: WebSocket, ctx: SessionContext): void {
  const latency = ctx.turnStartedAt !== null
    ? Date.now() - ctx.turnStartedAt
    : -1;

  const msg: ServerMessage = {
    type: 'turn_complete',
    session_id: ctx.sessionId,
    total_latency_ms: latency,
    token_count: ctx.tokenCount,
    timestamp_ms: Date.now(),
  };

  sendJson(ws, msg);
  ctx.turnStartedAt = null;
  ctx.tokenCount    = 0;
  // Do NOT kill Piper here. It is a persistent --json-input daemon that is
  // still synthesizing the sentences we just queued; SIGTERM would cut the
  // audio before any PCM is produced (the turn "completes" the instant the LLM
  // stream ends, long before TTS playback finishes). Piper is only terminated
  // on barge-in (KILL_PIPER) or server shutdown (stop()); between turns it idles.
  resetSentenceBuffer();
  setActiveSentenceBuffer(null);  // clear messageHandler reference
  console.log(`[${ctx.sessionId}] turn_complete (latency=${latency}ms)`);
}

function notifyClientError(ws: WebSocket, ctx: SessionContext): void {
  // If a specific error was stashed (e.g. an LLM/Groq failure), surface the
  // real code+message; otherwise default to the STT failure message.
  const pending = ctx.pendingError;
  const msg: ServerMessage = {
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

export function sendJson(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

export function emitStateChange(
  ws: WebSocket,
  from: ServerState,
  to: ServerState,
): void {
  if (from === to) return;
  const msg: ServerMessage = {
    type: 'state_change',
    from,
    to,
    timestamp_ms: Date.now(),
  };
  sendJson(ws, msg);
  console.log(`[state] ${from} → ${to}`);
}
