import WebSocket from 'ws';
import { SideEffectName, SessionContext, ServerMessage, ServerState, IncomingEventType } from './types';
export declare function setInternalEventEmitter(emitter: (event: IncomingEventType, payload?: unknown) => void): void;
export declare function getActiveWs(): WebSocket | null;
/**
 * Called once at server startup to spawn subprocesses and wire
 * Whisper transcript events into the state machine.
 * @param emitInternalEvent  Callback into messageHandler/server to fire internal events
 */
export declare function initSubprocesses(emitInternalEvent: (event: IncomingEventType, payload?: unknown) => void): void;
export interface SideEffectContext {
    ws: WebSocket;
    ctx: SessionContext;
}
export declare function dispatchSideEffects(effects: SideEffectName[], { ws, ctx }: SideEffectContext): void;
export declare function sendJson(ws: WebSocket, msg: ServerMessage): void;
export declare function emitStateChange(ws: WebSocket, from: ServerState, to: ServerState): void;
//# sourceMappingURL=sideEffects.d.ts.map