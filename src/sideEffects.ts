// ============================================================
// sideEffects.ts — Stub dispatcher for state machine effects
// Phase 1: all handlers log and return. Real I/O wired in
// Phases 3 (Whisper/Piper) and 4 (Groq/barge-in).
// ============================================================

import { SideEffectName, SessionContext, ServerMessage, ServerState } from './types';
import WebSocket from 'ws';

export interface SideEffectContext {
  ws: WebSocket;
  ctx: SessionContext;
}

/**
 * Dispatch a list of named side-effects in order.
 * All handlers are stubs in Phase 1.
 */
export function dispatchSideEffects(
  effects: SideEffectName[],
  { ws, ctx }: SideEffectContext,
): void {
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
        startGroqStream(ctx);
        break;
      case 'ABORT_GROQ_STREAM':
        abortGroqStream(ctx);
        break;
      case 'SPAWN_PIPER':
        spawnPiper(ctx);
        break;
      case 'KILL_PIPER':
        killPiper(ctx);
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

// ── Stub handlers ─────────────────────────────────────────────

function openWhisperPipe(ctx: SessionContext): void {
  console.log(`[stub][${ctx.sessionId}] OPEN_WHISPER_PIPE — will spawn faster_whisper_server.py in Phase 3`);
  // Phase 1: clear audio buffer for new utterance
  ctx.audioBuffer = [];
}

function sendEofToWhisper(ctx: SessionContext): void {
  const byteCount = ctx.audioBuffer.reduce((sum, b) => sum + b.length, 0);
  console.log(`[stub][${ctx.sessionId}] SEND_EOF_TO_WHISPER — ${ctx.audioBuffer.length} frames (${byteCount} bytes) buffered`);
}

function discardWhisperBuffer(ctx: SessionContext): void {
  console.log(`[stub][${ctx.sessionId}] DISCARD_WHISPER_BUFFER — dropping ${ctx.audioBuffer.length} frames`);
  ctx.audioBuffer = [];
}

function startGroqStream(ctx: SessionContext): void {
  console.log(`[stub][${ctx.sessionId}] START_GROQ_STREAM — will call Groq API in Phase 4`);
}

function abortGroqStream(ctx: SessionContext): void {
  console.log(`[stub][${ctx.sessionId}] ABORT_GROQ_STREAM — will call AbortController.abort() in Phase 4`);
}

function spawnPiper(ctx: SessionContext): void {
  console.log(`[stub][${ctx.sessionId}] SPAWN_PIPER — will spawn piper binary in Phase 3`);
}

function killPiper(ctx: SessionContext): void {
  console.log(`[stub][${ctx.sessionId}] KILL_PIPER — will SIGTERM piper process in Phase 3`);
}

function sendFillerTts(ws: WebSocket, ctx: SessionContext): void {
  console.log(`[stub][${ctx.sessionId}] SEND_FILLER_TTS — will pipe filler phrase to Piper in Phase 3`);
}

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

  ws.send(JSON.stringify(msg));
  ctx.turnStartedAt = null;
  ctx.tokenCount = 0;
  console.log(`[${ctx.sessionId}] turn_complete sent (latency=${latency}ms)`);
}

function notifyClientError(ws: WebSocket, ctx: SessionContext): void {
  const msg: ServerMessage = {
    type: 'error',
    session_id: ctx.sessionId,
    code: 'STT_FAIL',
    message: 'Speech transcription failed. Please try again.',
    recoverable: true,
    timestamp_ms: Date.now(),
  };
  ws.send(JSON.stringify(msg));
  console.error(`[${ctx.sessionId}] Whisper error — sent error frame to client`);
}

// ── Helper: send any typed server message ─────────────────────

export function sendJson(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ── Transition helper: emit state_change to client ───────────

export function emitStateChange(
  ws: WebSocket,
  from: ServerState,
  to: ServerState,
): void {
  if (from === to) return; // don't emit no-op state changes (e.g., LISTENING → LISTENING for PCM frames)
  const msg: ServerMessage = {
    type: 'state_change',
    from,
    to,
    timestamp_ms: Date.now(),
  };
  sendJson(ws, msg);
  console.log(`[state] ${from} → ${to}`);
}
