// ============================================================
// sentenceBuffer.ts — Sentence-boundary buffering for TTS
// Accumulates LLM token deltas and emits complete sentences
// to Piper so we don't start synthesis mid-sentence.
// ============================================================

// Regex matches sentence-ending or phrase-ending punctuation followed by whitespace or end-of-string.
// Also treats newlines as natural boundaries. We use commas and semicolons to stream chunks
// faster to TTS for lower latency audio onset.
const SENTENCE_END_RE = /[,.?!;:]+\s+|[,.?!;:]+$|\n/;

// Maximum ms to wait before flushing an incomplete fragment anyway. 
// We lowered this to force Piper to start synthesizing if the LLM emits a long phrase without punctuation.
const FLUSH_TIMEOUT_MS = 150;

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
    // Keep extracting from the front of the buffer while a sentence/phrase boundary exists
    let match: RegExpExecArray | null;
    while ((match = SENTENCE_END_RE.exec(this.buffer)) !== null) {
      const endIdx = match.index + match[0].length;
      const sentence = this.buffer.slice(0, endIdx).trim();
      this.buffer = this.buffer.slice(endIdx);

      if (sentence.length > 0) {
        this.onSentence(sentence);
      }
    }

    // If there's still content in the buffer and NO timer is running, start one.
    // We DO NOT clear the timer on every token anymore, otherwise a fast LLM token flood
    // without punctuation would wait indefinitely for the stream to end!
    if (this.buffer.trim().length > 0 && !this.flushTimer) {
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
