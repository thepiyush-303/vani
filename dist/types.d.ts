export declare enum ServerState {
    IDLE = "IDLE",
    LISTENING = "LISTENING",
    TRANSCRIBING = "TRANSCRIBING",
    LLM_STREAMING = "LLM_STREAMING",
    TTS_STREAMING = "TTS_STREAMING",
    BARGE_IN_INTERRUPTED = "BARGE_IN_INTERRUPTED",
    TOOL_EXECUTING = "TOOL_EXECUTING"
}
export type SideEffectName = 'OPEN_WHISPER_PIPE' | 'SEND_EOF_TO_WHISPER' | 'DISCARD_WHISPER_BUFFER' | 'START_GROQ_STREAM' | 'ABORT_GROQ_STREAM' | 'SPAWN_PIPER' | 'KILL_PIPER' | 'SEND_FILLER_TTS' | 'SEND_TURN_COMPLETE' | 'NOTIFY_CLIENT_ERROR' | 'NOOP';
export type IncomingEventType = 'session_init' | 'speech_start' | 'speech_end' | 'vad_misfire' | 'tool_result' | 'pcm_binary' | 'whisper_partial' | 'whisper_final' | 'whisper_error' | 'llm_token' | 'llm_tool_call' | 'llm_stream_complete' | 'llm_error' | 'tool_result_ready' | 'tool_timeout';
export interface IncomingEvent {
    type: IncomingEventType;
    payload?: any;
}
export interface SessionInitMessage {
    type: 'session_init';
    session_id: string;
    audio_format: {
        sample_rate: 16000;
        channels: 1;
        bit_depth: 16;
        encoding: 'pcm_s16le';
    };
    client_capabilities: {
        supports_barge_in: boolean;
        vad_library: string;
        browser: string;
    };
}
export interface SpeechStartMessage {
    type: 'speech_start';
    session_id: string;
    timestamp_ms: number;
}
export interface SpeechEndMessage {
    type: 'speech_end';
    session_id: string;
    duration_ms: number;
    timestamp_ms: number;
}
export interface VadMisfireMessage {
    type: 'vad_misfire';
    session_id: string;
    timestamp_ms: number;
}
export interface ToolResultMessage {
    type: 'tool_result';
    tool_call_id: string;
    result: unknown;
    error: string | null;
}
export type ClientMessage = SessionInitMessage | SpeechStartMessage | SpeechEndMessage | VadMisfireMessage | ToolResultMessage;
export interface SessionAckMessage {
    type: 'session_ack';
    session_id: string;
    server_version: string;
    tts_sample_rate: 22050;
    state: ServerState;
}
export interface StateChangeMessage {
    type: 'state_change';
    from: ServerState;
    to: ServerState;
    timestamp_ms: number;
}
export interface TranscriptPartialMessage {
    type: 'transcript_partial';
    session_id: string;
    text: string;
    confidence: number | null;
    timestamp_ms: number;
}
export interface TranscriptFinalMessage {
    type: 'transcript_final';
    session_id: string;
    text: string;
    duration_ms: number;
    timestamp_ms: number;
}
export interface LlmTokenMessage {
    type: 'llm_token';
    session_id: string;
    delta: string;
    token_index: number;
    timestamp_ms: number;
}
export interface ToolCallMessage {
    type: 'tool_call';
    session_id: string;
    tool_call_id: string;
    tool_name: string;
    arguments: Record<string, unknown>;
    timestamp_ms: number;
}
export interface TtsInterruptedMessage {
    type: 'tts_interrupted';
    session_id: string;
    reason: 'barge_in';
    timestamp_ms: number;
}
export interface TurnCompleteMessage {
    type: 'turn_complete';
    session_id: string;
    total_latency_ms: number;
    token_count: number;
    timestamp_ms: number;
}
export interface ErrorMessage {
    type: 'error';
    session_id: string;
    code: 'STT_FAIL' | 'LLM_TIMEOUT' | 'TTS_FAIL' | 'TOOL_TIMEOUT' | 'INVALID_STATE' | 'INTERNAL';
    message: string;
    recoverable: boolean;
    timestamp_ms: number;
}
export type ServerMessage = SessionAckMessage | StateChangeMessage | TranscriptPartialMessage | TranscriptFinalMessage | LlmTokenMessage | ToolCallMessage | TtsInterruptedMessage | TurnCompleteMessage | ErrorMessage;
export interface ConversationMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    tool_call_id?: string;
}
export interface SessionContext {
    sessionId: string;
    state: ServerState;
    audioBuffer: Buffer[];
    conversationHistory: ConversationMessage[];
    tokenCount: number;
    turnStartedAt: number | null;
    createdAt: number;
    pendingError?: {
        code: ErrorMessage['code'];
        message: string;
    };
}
//# sourceMappingURL=types.d.ts.map