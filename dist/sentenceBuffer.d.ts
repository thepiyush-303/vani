export type SentenceCallback = (sentence: string) => void;
export declare class SentenceBuffer {
    private buffer;
    private onSentence;
    private flushTimer;
    constructor(onSentence: SentenceCallback);
    /** Append a new token delta from the LLM stream. */
    append(delta: string): void;
    /**
     * Try to extract and emit complete sentences from the buffer.
     * Schedules a timeout flush for any remaining fragment.
     */
    private tryFlush;
    /**
     * Force-flush any remaining content immediately.
     * Call when the LLM stream signals completion.
     */
    flush(): void;
    /** Discard all buffered content without emitting. Used on barge-in. */
    reset(): void;
}
//# sourceMappingURL=sentenceBuffer.d.ts.map