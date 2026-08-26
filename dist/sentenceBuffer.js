"use strict";
// ============================================================
// sentenceBuffer.ts — Sentence-boundary buffering for TTS
// Accumulates LLM token deltas and emits complete sentences
// to Piper so we don't start synthesis mid-sentence.
// ============================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.SentenceBuffer = void 0;
// Regex matches sentence-ending punctuation followed by whitespace or end-of-string.
// Also treats newlines as natural boundaries.
const SENTENCE_END_RE = /[.?!]+\s+|[.?!]+$|\n/;
// Maximum ms to wait before flushing an incomplete fragment anyway.
const FLUSH_TIMEOUT_MS = 200;
class SentenceBuffer {
    buffer = '';
    onSentence;
    flushTimer = null;
    constructor(onSentence) {
        this.onSentence = onSentence;
    }
    /** Append a new token delta from the LLM stream. */
    append(delta) {
        this.buffer += delta;
        this.tryFlush();
    }
    /**
     * Try to extract and emit complete sentences from the buffer.
     * Schedules a timeout flush for any remaining fragment.
     */
    tryFlush() {
        // Reset timeout on each new token — we start it fresh
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        // Keep extracting from the front of the buffer while a sentence boundary exists
        let match;
        while ((match = SENTENCE_END_RE.exec(this.buffer)) !== null) {
            const endIdx = match.index + match[0].length;
            const sentence = this.buffer.slice(0, endIdx).trim();
            this.buffer = this.buffer.slice(endIdx);
            if (sentence.length > 0) {
                this.onSentence(sentence);
            }
        }
        // If there's still content in the buffer, schedule a forced flush
        if (this.buffer.trim().length > 0) {
            this.flushTimer = setTimeout(() => {
                const remaining = this.buffer.trim();
                if (remaining.length > 0) {
                    this.buffer = '';
                    this.onSentence(remaining);
                }
                this.flushTimer = null;
            }, FLUSH_TIMEOUT_MS);
        }
    }
    /**
     * Force-flush any remaining content immediately.
     * Call when the LLM stream signals completion.
     */
    flush() {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        const remaining = this.buffer.trim();
        this.buffer = '';
        if (remaining.length > 0) {
            this.onSentence(remaining);
        }
    }
    /** Discard all buffered content without emitting. Used on barge-in. */
    reset() {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        this.buffer = '';
    }
}
exports.SentenceBuffer = SentenceBuffer;
//# sourceMappingURL=sentenceBuffer.js.map