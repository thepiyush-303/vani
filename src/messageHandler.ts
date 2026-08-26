// ============================================================
// messageHandler.ts — Routes incoming WS messages through the
// state machine and dispatches side effects.
// ============================================================

import WebSocket from 'ws';
import { SessionContext, ServerState, ClientMessage, ServerMessage, IncomingEventType } from './types';
import { transition, isTransitionError } from './stateMachine';
import { dispatchSideEffects, emitStateChange, sendJson } from './sideEffects';
import { getActiveSentenceBuffer, setActiveSentenceBuffer } from './sharedState';

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

/**
 * Handle internal events fired by subprocess callbacks (Whisper, Piper, Groq).
 * Called from server.ts when a subprocess emits a transcript or error.
 */
export function handleInternalEvent(
  eventType: IncomingEventType,
  payload: unknown,
  ws: WebSocket,
  ctx: SessionContext,
): void {
  const p = payload as Record<string, unknown> | undefined;

  switch (eventType) {
    case 'whisper_partial': {
      // Send transcript_partial to browser; no state change
      const text = (p?.text as string) ?? '';
      const msg: ServerMessage = {
        type: 'transcript_partial',
        session_id: ctx.sessionId,
        text,
        confidence: null,
        timestamp_ms: Date.now(),
      };
      sendJson(ws, msg);
      break;
    }

    case 'whisper_final': {
      const text        = (p?.text as string) ?? '';
      const duration_ms = (p?.duration_ms as number) ?? 0;

      // 1. Send transcript_final to browser
      const msg: ServerMessage = {
        type: 'transcript_final',
        session_id: ctx.sessionId,
        text,
        duration_ms,
        timestamp_ms: Date.now(),
      };
      sendJson(ws, msg);
      console.log(`[${ctx.sessionId}] transcript_final: "${text.slice(0, 80)}"`);

      // 2. Append user turn to conversation history for Groq multi-turn
      ctx.conversationHistory.push({ role: 'user', content: text });

      // 3. Transition TRANSCRIBING → LLM_STREAMING
      // START_GROQ_STREAM side-effect will call triggerGroqStream() in sideEffects.ts
      runTransition(ws, ctx, 'whisper_final');
      break;
    }

    case 'whisper_error': {
      const msg_str = (p?.msg as string) ?? 'Unknown STT error';
      console.error(`[${ctx.sessionId}] whisper_error: ${msg_str}`);
      runTransition(ws, ctx, 'whisper_error');
      break;
    }

    case 'llm_token': {
      const delta      = (p?.delta as string) ?? '';
      const tokenIndex = (p?.tokenIndex as number) ?? 0;

      // 1. Stream token to browser for live text display
      const msg: ServerMessage = {
        type: 'llm_token',
        session_id: ctx.sessionId,
        delta,
        token_index: tokenIndex,
        timestamp_ms: Date.now(),
      };
      sendJson(ws, msg);

      // 2. Feed token to sentence buffer → fires Piper synthesis at sentence boundaries
      const activeSentenceBuffer = getActiveSentenceBuffer();
      if (activeSentenceBuffer) {
        activeSentenceBuffer.append(delta);
      }

      // 3. Transition LLM_STREAMING → TTS_STREAMING on first token
      if (ctx.state === ServerState.LLM_STREAMING) {
        runTransition(ws, ctx, 'llm_token');
      }
      break;
    }

    case 'llm_stream_complete': {
      // Flush any remaining buffered text to Piper
      const activeSentenceBuffer = getActiveSentenceBuffer();
      if (activeSentenceBuffer) {
        activeSentenceBuffer.flush();
        setActiveSentenceBuffer(null);
      }
      // Transition to IDLE; side-effect SEND_TURN_COMPLETE sends metrics to browser
      runTransition(ws, ctx, 'llm_stream_complete');
      break;
    }

    case 'llm_tool_call': {
      // Transition LLM_STREAMING → TOOL_EXECUTING; SEND_FILLER_TTS plays "One moment..."
      // Tool execution logic wired in Phase 5
      runTransition(ws, ctx, 'llm_tool_call');
      console.log(`[${ctx.sessionId}] llm_tool_call: ${String(p?.name)} (Phase 5 stub)`);
      break;
    }

    case 'llm_error': {
      const code = (p?.code as string) ?? 'UNKNOWN';
      const msg  = (p?.msg as string) ?? 'Unknown LLM error';
      console.error(`[${ctx.sessionId}] llm_error (${code}): ${msg}`);

      // Only meaningful while an LLM turn is in flight. If we've already reset
      // (e.g. a late/duplicate error), ignore it rather than emit INVALID_STATE.
      if (
        ctx.state !== ServerState.LLM_STREAMING &&
        ctx.state !== ServerState.TTS_STREAMING &&
        ctx.state !== ServerState.TOOL_EXECUTING
      ) {
        console.warn(`[${ctx.sessionId}] llm_error ignored in state ${ctx.state}`);
        break;
      }

      // Stash the real reason so NOTIFY_CLIENT_ERROR surfaces it to the browser.
      ctx.pendingError = {
        code: 'LLM_TIMEOUT',
        message: `LLM request failed (${code}): ${msg}`,
      };
      runTransition(ws, ctx, 'llm_error');
      break;
    }

    default:
      console.log(`[${ctx.sessionId}] Unhandled internal event: ${eventType}`);
  }
}
