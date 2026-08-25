// ============================================================
// sharedState.ts — Shared mutable state for cross-module access
// Breaks circular import between sideEffects.ts ↔ messageHandler.ts
// ============================================================

import { SentenceBuffer } from './sentenceBuffer';

/**
 * The active sentence buffer for the current turn.
 * Set by sideEffects.ts (SPAWN_PIPER) and consumed by messageHandler.ts (llm_token).
 * Reset to null when KILL_PIPER or turn_complete fires.
 */
let _activeSentenceBuffer: SentenceBuffer | null = null;

export function getActiveSentenceBuffer(): SentenceBuffer | null {
  return _activeSentenceBuffer;
}

export function setActiveSentenceBuffer(buf: SentenceBuffer | null): void {
  _activeSentenceBuffer = buf;
}
