// ============================================================
// stateMachine.test.ts
// Unit tests — one test per PRD §3.2 transition table row.
// All transitions tested; invalid transitions tested for error.
// ============================================================

import { transition, isTransitionError } from '../stateMachine';
import { ServerState } from '../types';

// ── Helpers ───────────────────────────────────────────────────

function expectTransition(
  from: ServerState,
  event: Parameters<typeof transition>[1],
  toState: ServerState,
  includesEffect?: string,
) {
  const result = transition(from, event);
  expect(isTransitionError(result)).toBe(false);
  if (isTransitionError(result)) return; // type narrowing

  expect(result.nextState).toBe(toState);
  if (includesEffect) {
    expect(result.sideEffects).toContain(includesEffect);
  }
}

function expectInvalidTransition(
  from: ServerState,
  event: Parameters<typeof transition>[1],
) {
  const result = transition(from, event);
  expect(isTransitionError(result)).toBe(true);
  if (isTransitionError(result)) {
    expect(result.code).toBe('INVALID_STATE');
  }
}

// ── IDLE ──────────────────────────────────────────────────────

describe('IDLE state', () => {
  it('speech_start → LISTENING, opens whisper pipe', () => {
    expectTransition(ServerState.IDLE, 'speech_start', ServerState.LISTENING, 'OPEN_WHISPER_PIPE');
  });

  it('vad_misfire → IDLE, no-op', () => {
    expectTransition(ServerState.IDLE, 'vad_misfire', ServerState.IDLE, 'NOOP');
  });

  it('speech_end in IDLE → INVALID_STATE', () => {
    expectInvalidTransition(ServerState.IDLE, 'speech_end');
  });

  it('pcm_binary in IDLE → INVALID_STATE', () => {
    expectInvalidTransition(ServerState.IDLE, 'pcm_binary');
  });
});

// ── LISTENING ────────────────────────────────────────────────

describe('LISTENING state', () => {
  it('pcm_binary → LISTENING (buffer frame)', () => {
    expectTransition(ServerState.LISTENING, 'pcm_binary', ServerState.LISTENING);
  });

  it('pcm_binary must NOT re-open the whisper pipe (would clear the audio buffer)', () => {
    const result = transition(ServerState.LISTENING, 'pcm_binary');
    expect(isTransitionError(result)).toBe(false);
    if (!isTransitionError(result)) {
      // OPEN_WHISPER_PIPE clears ctx.audioBuffer; firing it per-frame wipes the
      // buffered utterance and leaves Whisper nothing to transcribe at speech_end.
      expect(result.sideEffects).not.toContain('OPEN_WHISPER_PIPE');
    }
  });

  it('speech_end → TRANSCRIBING, sends EOF to whisper', () => {
    expectTransition(ServerState.LISTENING, 'speech_end', ServerState.TRANSCRIBING, 'SEND_EOF_TO_WHISPER');
  });

  it('vad_misfire → IDLE, discards buffer', () => {
    expectTransition(ServerState.LISTENING, 'vad_misfire', ServerState.IDLE, 'DISCARD_WHISPER_BUFFER');
  });

  it('speech_start in LISTENING → INVALID_STATE (guard)', () => {
    expectInvalidTransition(ServerState.LISTENING, 'speech_start');
  });
});

// ── TRANSCRIBING ─────────────────────────────────────────────

describe('TRANSCRIBING state', () => {
  it('whisper_partial → TRANSCRIBING (emit transcript, trigger pre-fetch)', () => {
    expectTransition(ServerState.TRANSCRIBING, 'whisper_partial', ServerState.TRANSCRIBING);
  });

  it('whisper_final → LLM_STREAMING, starts Groq stream', () => {
    expectTransition(ServerState.TRANSCRIBING, 'whisper_final', ServerState.LLM_STREAMING, 'START_GROQ_STREAM');
  });

  it('whisper_error → IDLE, notifies client', () => {
    expectTransition(ServerState.TRANSCRIBING, 'whisper_error', ServerState.IDLE, 'NOTIFY_CLIENT_ERROR');
  });

  it('speech_start in TRANSCRIBING → INVALID_STATE', () => {
    expectInvalidTransition(ServerState.TRANSCRIBING, 'speech_start');
  });
});

// ── LLM_STREAMING ────────────────────────────────────────────

describe('LLM_STREAMING state', () => {
  it('llm_token → TTS_STREAMING, spawns Piper', () => {
    expectTransition(ServerState.LLM_STREAMING, 'llm_token', ServerState.TTS_STREAMING, 'SPAWN_PIPER');
  });

  it('llm_tool_call → TOOL_EXECUTING, sends filler TTS', () => {
    expectTransition(ServerState.LLM_STREAMING, 'llm_tool_call', ServerState.TOOL_EXECUTING, 'SEND_FILLER_TTS');
  });

  it('llm_stream_complete → IDLE, sends turn_complete', () => {
    expectTransition(ServerState.LLM_STREAMING, 'llm_stream_complete', ServerState.IDLE, 'SEND_TURN_COMPLETE');
  });

  it('speech_start (barge-in) → BARGE_IN_INTERRUPTED, aborts Groq + kills Piper', () => {
    const result = transition(ServerState.LLM_STREAMING, 'speech_start');
    expect(isTransitionError(result)).toBe(false);
    if (!isTransitionError(result)) {
      expect(result.nextState).toBe(ServerState.BARGE_IN_INTERRUPTED);
      expect(result.sideEffects).toContain('ABORT_GROQ_STREAM');
      expect(result.sideEffects).toContain('KILL_PIPER');
    }
  });
});

// ── TTS_STREAMING ────────────────────────────────────────────

describe('TTS_STREAMING state', () => {
  it('llm_token → TTS_STREAMING (more tokens queued for Piper)', () => {
    expectTransition(ServerState.TTS_STREAMING, 'llm_token', ServerState.TTS_STREAMING);
  });

  it('llm_stream_complete → IDLE, sends turn_complete', () => {
    expectTransition(ServerState.TTS_STREAMING, 'llm_stream_complete', ServerState.IDLE, 'SEND_TURN_COMPLETE');
  });

  it('speech_start (barge-in) → BARGE_IN_INTERRUPTED, kills Piper', () => {
    const result = transition(ServerState.TTS_STREAMING, 'speech_start');
    expect(isTransitionError(result)).toBe(false);
    if (!isTransitionError(result)) {
      expect(result.nextState).toBe(ServerState.BARGE_IN_INTERRUPTED);
      expect(result.sideEffects).toContain('KILL_PIPER');
    }
  });
});

// ── TOOL_EXECUTING ───────────────────────────────────────────

describe('TOOL_EXECUTING state', () => {
  it('tool_result_ready → LLM_STREAMING, re-enters Groq stream', () => {
    expectTransition(ServerState.TOOL_EXECUTING, 'tool_result_ready', ServerState.LLM_STREAMING, 'START_GROQ_STREAM');
  });

  it('tool_timeout → LLM_STREAMING, injects error + re-enters Groq stream', () => {
    expectTransition(ServerState.TOOL_EXECUTING, 'tool_timeout', ServerState.LLM_STREAMING, 'START_GROQ_STREAM');
  });

  it('speech_start in TOOL_EXECUTING → INVALID_STATE', () => {
    expectInvalidTransition(ServerState.TOOL_EXECUTING, 'speech_start');
  });
});

// ── BARGE_IN_INTERRUPTED ─────────────────────────────────────

describe('BARGE_IN_INTERRUPTED state', () => {
  it('speech_start → LISTENING, re-opens whisper pipe', () => {
    expectTransition(ServerState.BARGE_IN_INTERRUPTED, 'speech_start', ServerState.LISTENING, 'OPEN_WHISPER_PIPE');
  });

  it('vad_misfire → IDLE', () => {
    expectTransition(ServerState.BARGE_IN_INTERRUPTED, 'vad_misfire', ServerState.IDLE, 'NOOP');
  });

  it('whisper_final in BARGE_IN_INTERRUPTED → INVALID_STATE', () => {
    expectInvalidTransition(ServerState.BARGE_IN_INTERRUPTED, 'whisper_final');
  });
});
