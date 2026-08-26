import WebSocket from 'ws';
/**
 * Initialize Piper. Returns false if model path is not configured.
 * Call at server startup; must be called before synthesize().
 */
export declare function start(): boolean;
/**
 * Send a sentence to Piper for synthesis.
 * Piper receives JSON-line: {"text": "..."}\n
 * Its stdout (raw PCM) is streamed back to the provided WebSocket.
 */
export declare function synthesize(text: string, ws: WebSocket): void;
/**
 * Synthesize the standard filler phrase for tool execution wait.
 * PRD §5.1: played immediately when server enters TOOL_EXECUTING state.
 */
export declare function sendFillerPhrase(ws: WebSocket): void;
/**
 * Kill the Piper subprocess immediately.
 * Used for barge-in (PRD §5.2): must complete within 50ms.
 * The process will auto-restart after RESTART_DELAY_MS.
 */
export declare function kill(): void;
/**
 * Stop Piper permanently (server shutdown).
 */
export declare function stop(): void;
//# sourceMappingURL=piperProcess.d.ts.map