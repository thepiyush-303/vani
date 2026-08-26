"use strict";
// ============================================================
// session.ts — SessionContext factory and store
// Single-user per PRD §1.2 (no multi-tenancy on local hardware)
// ============================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionStore = void 0;
exports.createSession = createSession;
const types_1 = require("./types");
function createSession(sessionId) {
    return {
        sessionId,
        state: types_1.ServerState.IDLE,
        audioBuffer: [],
        conversationHistory: [
            {
                role: 'system',
                content: [
                    'You are a helpful voice assistant.',
                    'Respond concisely in 1-2 sentences.',
                    'For tool calls, extract all required parameters before calling.',
                    'If required parameters are missing, ask for them conversationally before calling the tool.',
                ].join(' '),
            },
        ],
        tokenCount: 0,
        turnStartedAt: null,
        createdAt: Date.now(),
    };
}
// Single active session — enforced at connection time in server.ts
let activeSession = null;
exports.SessionStore = {
    set(ctx) {
        activeSession = ctx;
    },
    get() {
        return activeSession;
    },
    getOrThrow() {
        if (!activeSession) {
            throw new Error('No active session');
        }
        return activeSession;
    },
    clear() {
        if (activeSession) {
            console.log(`[session] Session ${activeSession.sessionId} cleared`);
        }
        activeSession = null;
    },
    has() {
        return activeSession !== null;
    },
};
//# sourceMappingURL=session.js.map