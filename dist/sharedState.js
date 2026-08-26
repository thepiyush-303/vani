"use strict";
// ============================================================
// sharedState.ts — Shared mutable state for cross-module access
// Breaks circular import between sideEffects.ts ↔ messageHandler.ts
// ============================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.getActiveSentenceBuffer = getActiveSentenceBuffer;
exports.setActiveSentenceBuffer = setActiveSentenceBuffer;
/**
 * The active sentence buffer for the current turn.
 * Set by sideEffects.ts (SPAWN_PIPER) and consumed by messageHandler.ts (llm_token).
 * Reset to null when KILL_PIPER or turn_complete fires.
 */
let _activeSentenceBuffer = null;
function getActiveSentenceBuffer() {
    return _activeSentenceBuffer;
}
function setActiveSentenceBuffer(buf) {
    _activeSentenceBuffer = buf;
}
//# sourceMappingURL=sharedState.js.map