import WebSocket from 'ws';
import { SessionContext, IncomingEventType } from './types';
/**
 * Handle a text (JSON) message from the client.
 * Parses, validates, maps to an IncomingEventType, then runs
 * the state machine and dispatches resulting side-effects.
 */
export declare function handleTextMessage(raw: string, ws: WebSocket, ctx: SessionContext): void;
/**
 * Handle a binary (PCM) frame from the client.
 * Only valid in LISTENING state — all other states reject and log a warning.
 */
export declare function handleBinaryMessage(buf: Buffer, ws: WebSocket, ctx: SessionContext): void;
/**
 * Handle internal events fired by subprocess callbacks (Whisper, Piper, Groq).
 * Called from server.ts when a subprocess emits a transcript or error.
 */
export declare function handleInternalEvent(eventType: IncomingEventType, payload: unknown, ws: WebSocket, ctx: SessionContext): void;
//# sourceMappingURL=messageHandler.d.ts.map