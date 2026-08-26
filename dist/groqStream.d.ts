import { SessionContext } from './types';
export declare function abortGroqStream(): void;
export type GroqEventCallback = (event: {
    type: 'llm_token';
    delta: string;
    tokenIndex: number;
} | {
    type: 'llm_tool_call';
    name: string;
    args: string;
} | {
    type: 'llm_stream_complete';
    fullText: string;
} | {
    type: 'llm_error';
    code: string;
    msg: string;
}) => void;
/**
 * Start a streaming Groq chat completion.
 *
 * @param ctx - Active session context (reads conversationHistory)
 * @param onEvent - Callback fired for each streaming event
 */
export declare function startGroqStream(ctx: SessionContext, onEvent: GroqEventCallback): Promise<void>;
//# sourceMappingURL=groqStream.d.ts.map