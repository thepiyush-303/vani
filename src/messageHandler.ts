// ============================================================
// messageHandler.ts — Routes incoming WS messages through the
// state machine and dispatches side effects.
// ============================================================

import WebSocket from 'ws';
import { SessionContext, ServerState, ClientMessage, ServerMessage } from './types';
import { transition, isTransitionError } from './stateMachine';
import { dispatchSideEffects, emitStateChange, sendJson } from './sideEffects';

/**
 * Handle a text (JSON) message from the client.
 * Parses, validates, maps to an IncomingEventType, then runs
 * the state machine and dispatches resulting side-effects.
 */
export function handleTextMessage(
  raw: string,
  ws: WebSocket,
  ctx: SessionContext,
): void {
  let msg: ClientMessage;

  // ── 1. Parse ───────────────────────────────────────────────
  try {
    msg = JSON.parse(raw) as ClientMessage;
  } catch {
    sendError(ws, ctx, 'INTERNAL', 'Malformed JSON payload', true);
    return;
  }

  // ── 2. Map message type → internal event ──────────────────
  switch (msg.type) {
    case 'session_init':
      // session_init is handled by server.ts before messageHandler is active
      // If we receive it mid-session, ignore it.
      console.warn(`[${ctx.sessionId}] Received unexpected session_init mid-session — ignoring`);
      return;

    case 'speech_start': {
      ctx.turnStartedAt = Date.now();
      runTransition(ws, ctx, 'speech_start');
      break;
    }

    case 'speech_end': {
      runTransition(ws, ctx, 'speech_end');
      break;
    }

    case 'vad_misfire': {
      runTransition(ws, ctx, 'vad_misfire');
      break;
    }

    case 'tool_result': {
      // Tool results are client-side only per PRD; server handles this internally.
      // Placeholder for Phase 5.
      console.log(`[${ctx.sessionId}] Received tool_result for call_id=${msg.tool_call_id} (Phase 5 stub)`);
      break;
    }

    default: {
      // Exhaustiveness guard — TypeScript should catch this at compile time
      const unreachable = msg as { type: string };
      sendError(ws, ctx, 'INTERNAL', `Unknown message type: ${unreachable.type}`, true);
    }
  }
}

/**
 * Handle a binary (PCM) frame from the client.
 * Only valid in LISTENING state — all other states reject and log a warning.
 */
export function handleBinaryMessage(
  buf: Buffer,
  ws: WebSocket,
  ctx: SessionContext,
): void {
  if (ctx.state !== ServerState.LISTENING) {
    console.warn(
      `[${ctx.sessionId}] Binary PCM received in state ${ctx.state} — dropping ${buf.length} bytes`,
    );
    return;
  }

  // Buffer the PCM chunk in-memory (no disk writes per PRD §1.3 privacy req)
  ctx.audioBuffer.push(buf);

  // State machine: LISTENING + pcm_binary → LISTENING (no state_change emitted)
  const result = transition(ctx.state, 'pcm_binary');
  if (isTransitionError(result)) {
    console.error(`[${ctx.sessionId}] Unexpected: ${result.message}`);
    return;
  }
  // Side effects for pcm_binary are dispatched without a state_change emit
  dispatchSideEffects(result.sideEffects, { ws, ctx });
}

// ── Internal helpers ──────────────────────────────────────────

/**
 * Run a state machine transition, dispatch side-effects, and emit
 * a state_change message to the client if the state actually changed.
 */
function runTransition(
  ws: WebSocket,
  ctx: SessionContext,
  event: Parameters<typeof transition>[1],
): void {
  const prevState = ctx.state;
  const result = transition(ctx.state, event);

  if (isTransitionError(result)) {
    console.warn(`[${ctx.sessionId}] ${result.message}`);
    sendError(ws, ctx, 'INVALID_STATE', result.message, true);
    return;
  }

  ctx.state = result.nextState;
  emitStateChange(ws, prevState, result.nextState);
  dispatchSideEffects(result.sideEffects, { ws, ctx });
}

function sendError(
  ws: WebSocket,
  ctx: SessionContext,
  code: ServerMessage & { type: 'error' } extends { code: infer C } ? C : never,
  message: string,
  recoverable: boolean,
): void {
  const msg: ServerMessage = {
    type: 'error',
    session_id: ctx.sessionId,
    code,
    message,
    recoverable,
    timestamp_ms: Date.now(),
  };
  sendJson(ws, msg);
}
