// ============================================================
// protocol.ts — the wire contract, client side.
// Mirrors the server→client half of src/types.ts. Kept as a
// separate copy because the client is a separate build with its
// own tsconfig; if you change a message shape, change both.
// ============================================================

export const SAMPLE_RATE = 16000; // PRD §2.1 — exactly 16kHz
export const FRAME_SIZE = 512; // PRD §2.1/§2.2 — 512 samples = 32ms
export const TTS_SAMPLE_RATE = 22050; // PRD §2.4 — Piper's output rate

// Server state machine (src/types.ts ServerState). A union rather than an
// enum: the client tsconfig sets erasableSyntaxOnly, which forbids enums.
export type ServerState =
  | 'IDLE'
  | 'LISTENING'
  | 'TRANSCRIBING'
  | 'LLM_STREAMING'
  | 'TTS_STREAMING'
  | 'BARGE_IN_INTERRUPTED'
  | 'TOOL_EXECUTING';

export interface GroundingSource {
  title: string;
  uri: string;
}

/** One persisted line of conversation, as loaded from the server on connect. */
export interface PersistedTurn {
  role: 'user' | 'assistant';
  content: string;
  session_id: string;
  ts: number;
}

export type ServerMessage =
  | { type: 'session_ack'; session_id: string; server_version: string; tts_sample_rate: number; state: ServerState }
  | { type: 'state_change'; from: ServerState; to: ServerState; timestamp_ms: number }
  | { type: 'transcript_partial'; session_id: string; text: string; confidence: number | null; timestamp_ms: number }
  | { type: 'transcript_final'; session_id: string; text: string; duration_ms: number; timestamp_ms: number }
  | { type: 'llm_token'; session_id: string; delta: string; token_index: number; timestamp_ms: number }
  | { type: 'tool_call'; session_id: string; tool_call_id: string; tool_name: string; arguments: Record<string, unknown>; timestamp_ms: number }
  | { type: 'tts_interrupted'; session_id: string; reason: 'barge_in'; timestamp_ms: number }
  | { type: 'turn_complete'; session_id: string; total_latency_ms: number; token_count: number; timestamp_ms: number }
  | { type: 'error'; session_id: string; code: string; message: string; recoverable: boolean; timestamp_ms: number }
  | { type: 'grounding_sources'; session_id: string; queries: string[]; sources: GroundingSource[]; timestamp_ms: number }
  | { type: 'history_load'; session_id: string; turns: PersistedTurn[] };

export type ClientMessage =
  | {
      type: 'session_init';
      session_id: string;
      audio_format: { sample_rate: number; channels: 1; bit_depth: 16; encoding: 'pcm_s16le' };
      client_capabilities: { supports_barge_in: boolean; vad_library: string; browser: string };
    }
  | { type: 'speech_start'; session_id: string; timestamp_ms: number }
  | { type: 'speech_end'; session_id: string; duration_ms: number; timestamp_ms: number }
  | { type: 'vad_misfire'; session_id: string; timestamp_ms: number };

// ── UI-facing projections ─────────────────────────────────────

export type Connection = 'disconnected' | 'connecting' | 'connected';

/** What the user is being told is happening, independent of connection. */
export type Turn = 'idle' | 'listening' | 'thinking' | 'speaking';

/** Server state → turn. TTS_STREAMING is deliberately *not* mapped to
 *  'speaking': the server leaves that state the moment the last audio chunk is
 *  written, seconds before the user stops hearing it. The UI decides
 *  'speaking' from the playback clock instead (see useAudioPlayback). */
export function turnFor(state: ServerState): Turn {
  switch (state) {
    case 'LISTENING':
      return 'listening';
    case 'TRANSCRIBING':
    case 'LLM_STREAMING':
    case 'TOOL_EXECUTING':
      return 'thinking';
    case 'TTS_STREAMING':
      return 'speaking';
    case 'IDLE':
    case 'BARGE_IN_INTERRUPTED':
      return 'idle';
  }
}

export type LogKind = 'sys' | 'in' | 'out' | 'err';

export interface LogEntry {
  id: number;
  at: string; // HH:MM:SS.mmm
  kind: LogKind;
  text: string;
}
