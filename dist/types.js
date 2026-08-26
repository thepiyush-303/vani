"use strict";
// ============================================================
// types.ts — All shared types for the voice agent server
// Derived from PRD §3 (WebSocket Protocol & State Machine)
// ============================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.ServerState = void 0;
// ── Server State Machine ─────────────────────────────────────
var ServerState;
(function (ServerState) {
    ServerState["IDLE"] = "IDLE";
    ServerState["LISTENING"] = "LISTENING";
    ServerState["TRANSCRIBING"] = "TRANSCRIBING";
    ServerState["LLM_STREAMING"] = "LLM_STREAMING";
    ServerState["TTS_STREAMING"] = "TTS_STREAMING";
    ServerState["BARGE_IN_INTERRUPTED"] = "BARGE_IN_INTERRUPTED";
    ServerState["TOOL_EXECUTING"] = "TOOL_EXECUTING";
})(ServerState || (exports.ServerState = ServerState = {}));
//# sourceMappingURL=types.js.map