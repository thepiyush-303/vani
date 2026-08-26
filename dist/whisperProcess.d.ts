export type WhisperTranscriptEvent = {
    type: 'partial';
    text: string;
    ts: number;
} | {
    type: 'final';
    text: string;
    duration_ms: number;
    ts: number;
} | {
    type: 'error';
    code: string;
    msg: string;
};
export type WhisperTranscriptCallback = (event: WhisperTranscriptEvent) => void;
/**
 * Register a callback to receive transcript events.
 * Must be called before start().
 */
export declare function onWhisperEvent(cb: WhisperTranscriptCallback): void;
/**
 * Start (or restart) the Faster-Whisper subprocess.
 * Safe to call multiple times — idempotent if already running.
 */
export declare function start(): void;
/**
 * Write a PCM chunk to Whisper's stdin with a 4-byte length prefix.
 * PRD §2.3: [uint32 LE byte_count][int16 PCM bytes]
 */
export declare function writeChunk(pcmBuffer: Buffer): void;
/**
 * Signal end-of-utterance by sending a 4-byte zero sentinel.
 * Whisper will transcribe the accumulated audio and emit a "final" JSON line.
 */
export declare function sendEof(): void;
/**
 * Discard any pending audio — used when VAD misfire resets to IDLE.
 * Sets discard flag to ignore the next "final" response if one somehow arrives.
 */
export declare function discard(): void;
/**
 * Stop the subprocess permanently (server shutdown).
 */
export declare function stop(): void;
//# sourceMappingURL=whisperProcess.d.ts.map