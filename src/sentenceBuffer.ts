// ============================================================
// sentenceBuffer.ts — Sentence-boundary buffering for TTS
// Accumulates LLM token deltas and emits complete sentences
// to Piper so we don't start synthesis mid-sentence.
// ============================================================

// Regex matches sentence-ending punctuation followed by whitespace or end-of-string.
// Also treats newlines as natural boundaries.
const SENTENCE_END_RE = /[.?!]+\s+|[.?!]+$|\n/;

// Maximum ms to wait before flushing an incomplete fragment anyway.
const FLUSH_TIMEOUT_MS = 200;

export type SentenceCallback = (sentence: string) => void;

export class SentenceBuffer {
  private buffer = '';
  private onSentence: SentenceCallback;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(onSentence: SentenceCallback) {
    this.onSentence = onSentence;
  }

  /** Append a new token delta from the LLM stream. */
  append(delta: string): void {
    this.buffer += delta;
    this.tryFlush();
  }

  /**
   * Try to extract and emit complete sentences from the buffer.
   * Schedules a timeout flush for any remaining fragment.
   */
  private tryFlush(): void {
    // Reset timeout on each new token — we start it fresh
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    // Keep extracting from the front of the buffer while a sentence boundary exists
    let match: RegExpExecArray | null;
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
  flush(): void {
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
  reset(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.buffer = '';
  }
}
