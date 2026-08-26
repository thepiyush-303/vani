// ============================================================
// stateMachine.ts — Pure state transition function
// Each row in PRD §3.2 is a case in this switch.
// Returns { nextState, sideEffects } — no I/O, fully testable.
// ============================================================

import { ServerState, SideEffectName, IncomingEventType } from './types';

export interface TransitionResult {
  nextState: ServerState;
  sideEffects: SideEffectName[];
}

export interface TransitionError {
  code: 'INVALID_STATE';
  message: string;
}

export type TransitionOutcome = TransitionResult | TransitionError;

export function isTransitionError(r: TransitionOutcome): r is TransitionError {
  return 'code' in r;
}

/**
 * Pure state machine transition.
 * Returns the next state and a list of named side-effects to execute.
 * Never performs I/O itself.
 */
export function transition(
  currentState: ServerState,
  event: IncomingEventType,
): TransitionOutcome {
  switch (currentState) {
    // ── IDLE ──────────────────────────────────────────────────
    case ServerState.IDLE:
      switch (event) {
        case 'speech_start':
          return {
            nextState: ServerState.LISTENING,
            sideEffects: ['OPEN_WHISPER_PIPE'],
          };
        case 'vad_misfire':
          // No-op: stay IDLE, no side effects
          return {
            nextState: ServerState.IDLE,
            sideEffects: ['NOOP'],
          };
        default:
          return invalidTransition(currentState, event);
      }

    // ── LISTENING ─────────────────────────────────────────────
    case ServerState.LISTENING:
      switch (event) {
        case 'pcm_binary':
          // Frame is already buffered in ctx.audioBuffer by handleBinaryMessage.
          // Must NOT re-open the whisper pipe here: OPEN_WHISPER_PIPE clears
          // ctx.audioBuffer, which would wipe the buffered utterance on every
          // frame and leave Whisper with nothing to transcribe at speech_end.
          return {
            nextState: ServerState.LISTENING,
            sideEffects: ['NOOP'],
          };
        case 'speech_end':
          return {
            nextState: ServerState.TRANSCRIBING,
            sideEffects: ['SEND_EOF_TO_WHISPER'],
          };
        case 'vad_misfire':
          return {
            nextState: ServerState.IDLE,
            sideEffects: ['DISCARD_WHISPER_BUFFER'],
          };
        default:
          return invalidTransition(currentState, event);
      }

    // ── TRANSCRIBING ──────────────────────────────────────────
    case ServerState.TRANSCRIBING:
      switch (event) {
        case 'whisper_partial':
          // Emit transcript_partial to client, trigger pre-fetch
          return {
            nextState: ServerState.TRANSCRIBING,
            sideEffects: ['NOOP'],
          };
        case 'whisper_final':
          return {
            nextState: ServerState.LLM_STREAMING,
            sideEffects: ['START_GROQ_STREAM'],
          };
        case 'whisper_error':
          return {
            nextState: ServerState.IDLE,
            sideEffects: ['NOTIFY_CLIENT_ERROR'],
          };
        // VAD events can arrive while Whisper is working; silently ignore them.
        case 'speech_start':
        case 'speech_end':
        case 'vad_misfire':
          return { nextState: ServerState.TRANSCRIBING, sideEffects: ['NOOP'] };
        default:
          return invalidTransition(currentState, event);
      }

    // ── LLM_STREAMING ─────────────────────────────────────────
    case ServerState.LLM_STREAMING:
      switch (event) {
        case 'llm_token':
          // Buffer token; check sentence boundary; pipe to Piper when ready
          return {
            nextState: ServerState.TTS_STREAMING,
            sideEffects: ['SPAWN_PIPER'],
          };
        case 'llm_tool_call':
          return {
            nextState: ServerState.TOOL_EXECUTING,
            sideEffects: ['SEND_FILLER_TTS', 'EXECUTE_TOOL'],
          };
        case 'llm_stream_complete':
          return {
            nextState: ServerState.IDLE,
            sideEffects: ['SEND_TURN_COMPLETE'],
          };
        case 'speech_start':
          // Barge-in while generating
          return {
            nextState: ServerState.BARGE_IN_INTERRUPTED,
            sideEffects: ['ABORT_GROQ_STREAM', 'KILL_PIPER'],
          };
        case 'llm_error':
          // Groq stream failed (bad key, decommissioned model, network, etc.)
          // before/while generating — reset to IDLE and surface the real error.
          return {
            nextState: ServerState.IDLE,
            sideEffects: ['ABORT_GROQ_STREAM', 'NOTIFY_CLIENT_ERROR'],
          };
        default:
          return invalidTransition(currentState, event);
      }

    // ── TTS_STREAMING ─────────────────────────────────────────
    case ServerState.TTS_STREAMING:
      switch (event) {
        case 'llm_token':
          // More tokens arriving; keep producing TTS
          return {
            nextState: ServerState.TTS_STREAMING,
            sideEffects: ['NOOP'],
          };
        case 'llm_stream_complete':
          // LLM done — wait for Piper to drain then go IDLE
          return {
            nextState: ServerState.IDLE,
            sideEffects: ['SEND_TURN_COMPLETE'],
          };
        case 'llm_error':
          // Groq stream failed mid-response — stop TTS playback and reset.
          return {
            nextState: ServerState.IDLE,
            sideEffects: ['ABORT_GROQ_STREAM', 'KILL_PIPER', 'NOTIFY_CLIENT_ERROR'],
          };
        // VAD fires on TTS playback audio; ignore to avoid barge-in false positives.
        case 'speech_start':
        case 'speech_end':
        case 'vad_misfire':
          return { nextState: ServerState.TTS_STREAMING, sideEffects: ['NOOP'] };
        default:
          return invalidTransition(currentState, event);
      }

    // ── TOOL_EXECUTING ────────────────────────────────────────
    case ServerState.TOOL_EXECUTING:
      switch (event) {
        case 'tool_result_ready':
          // Tool returned successfully; re-enter LLM stream with result
          return {
            nextState: ServerState.LLM_STREAMING,
            sideEffects: ['START_GROQ_STREAM'],
          };
        case 'tool_timeout':
          // Inject synthetic error result and continue
          return {
            nextState: ServerState.LLM_STREAMING,
            sideEffects: ['START_GROQ_STREAM'],
          };
        case 'llm_error':
          // LLM continuation after a tool call failed — reset and surface error.
          return {
            nextState: ServerState.IDLE,
            sideEffects: ['ABORT_GROQ_STREAM', 'NOTIFY_CLIENT_ERROR'],
          };
        default:
          return invalidTransition(currentState, event);
      }

    // ── BARGE_IN_INTERRUPTED ──────────────────────────────────
    case ServerState.BARGE_IN_INTERRUPTED:
      switch (event) {
        case 'speech_start':
          // New utterance starts after barge-in flush
          return {
            nextState: ServerState.LISTENING,
            sideEffects: ['OPEN_WHISPER_PIPE'],
          };
        case 'vad_misfire':
        case 'speech_end':
          // Ignore stale events that arrive after barge-in
          return { nextState: ServerState.BARGE_IN_INTERRUPTED, sideEffects: ['NOOP'] };
        default:
          return invalidTransition(currentState, event);
      }

    default:
      return invalidTransition(currentState, event);
  }
}

function invalidTransition(
  state: ServerState,
  event: IncomingEventType,
): TransitionError {
  return {
    code: 'INVALID_STATE',
    message: `Event "${event}" is not valid in state "${state}"`,
  };
}
