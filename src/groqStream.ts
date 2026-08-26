// ============================================================
// groqStream.ts — Groq LLM streaming integration
// PRD §4: chat LLM via Groq LPU, streaming (model set by GROQ_MODEL env)
// ============================================================

import Groq from 'groq-sdk';
import WebSocket from 'ws';
import { SessionContext } from './types';

// ── Groq client singleton ─────────────────────────────────────

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY ?? '',
});

const GROQ_MODEL = process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile';
const MAX_TOKENS = 512;   // Cap only — the system prompt drives brevity; leaves room for a genuinely long answer
const TEMPERATURE = 0.7;
const MAX_RETRIES = 2;     // Retry once on 429 rate-limit
const RETRY_DELAY_MS = 1000;

// gpt-oss models "think" before answering; the model default can spend several
// seconds reasoning, which blows the voice latency budget. 'low' keeps a little
// reasoning while cutting time-to-first-token. For the absolute fastest replies
// set this to 'none' (no reasoning). Options: 'none' | 'low' | 'medium' | 'high'.
// Only meaningful for gpt-oss / reasoning models.
const REASONING_EFFORT: 'none' | 'low' | 'medium' | 'high' = 'low';

// reasoning_effort is only valid for reasoning models (gpt-oss, qwen-qwq,
// deepseek-r1, o1/o3). Standard instruct models like llama-3.3-70b reject the
// parameter, so we only send it when the active model actually supports it.
function isReasoningModel(model: string): boolean {
  return /gpt-oss|qwq|deepseek-r1|o[13]/i.test(model);
}

// ── System prompt ─────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a helpful voice assistant. Your replies are spoken aloud, so match their \
length to the question. For simple, casual, or factual questions, answer in a single short sentence. Use at \
most one or two sentences for most questions, and never pad a short answer with detail the user did not ask \
for. Only give a longer, multi-sentence reply when the question genuinely needs it — such as an explanation, \
a comparison, or step-by-step instructions. Avoid markdown, bullet points, or lists; speak naturally and directly.`;

// ── Abort controller for barge-in ────────────────────────────

let activeAbortController: AbortController | null = null;

export function abortGroqStream(): void {
  if (activeAbortController) {
    activeAbortController.abort();
    activeAbortController = null;
    console.log('[groq] Stream aborted (barge-in)');
  }
}

// ── Public API ────────────────────────────────────────────────

export type GroqEventCallback = (
  event:
    | { type: 'llm_token'; delta: string; tokenIndex: number }
    | { type: 'llm_tool_call'; name: string; args: string }
    | { type: 'llm_stream_complete'; fullText: string }
    | { type: 'llm_error'; code: string; msg: string }
) => void;

/**
 * Start a streaming Groq chat completion.
 *
 * @param ctx - Active session context (reads conversationHistory)
 * @param onEvent - Callback fired for each streaming event
 */
export async function startGroqStream(
  ctx: SessionContext,
  onEvent: GroqEventCallback,
): Promise<void> {
  // Ensure we have at least one user message to send
  if (ctx.conversationHistory.length === 0) {
    console.warn('[groq] startGroqStream called with empty conversation history');
    onEvent({ type: 'llm_stream_complete', fullText: '' });
    return;
  }

  // Build message array with system prompt prepended
  const messages: Groq.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...ctx.conversationHistory.map((m) => ({
      role: m.role as 'user' | 'assistant' | 'system',
      content: m.content,
    })),
  ];

  console.log(`[groq] Starting stream — model=${GROQ_MODEL} history=${ctx.conversationHistory.length} msgs`);

  activeAbortController = new AbortController();
  const signal = activeAbortController.signal;

  let attempt = 0;
  while (attempt <= MAX_RETRIES) {
    try {
      await streamCompletion(messages, signal, ctx, onEvent);
      return;  // success
    } catch (err: unknown) {
      const error = err as { status?: number; message?: string; name?: string };

      // Aborted by barge-in — not an error
      if (error.name === 'AbortError' || signal.aborted) {
        console.log('[groq] Stream cancelled by barge-in');
        return;
      }

      // 429 Rate limit — retry after delay
      if (error.status === 429 && attempt < MAX_RETRIES) {
        attempt++;
        console.warn(`[groq] Rate limited (429) — retrying in ${RETRY_DELAY_MS}ms (attempt ${attempt}/${MAX_RETRIES})`);
        await sleep(RETRY_DELAY_MS);
        continue;
      }

      // Any other error — emit and give up
      const msg = error.message ?? 'Unknown Groq error';
      console.error(`[groq] Stream error (status=${error.status}): ${msg}`);
      onEvent({ type: 'llm_error', code: String(error.status ?? 'UNKNOWN'), msg });
      return;
    } finally {
      if (attempt === 0 || attempt > MAX_RETRIES) {
        activeAbortController = null;
      }
    }
  }
}

// ── Internal streaming function ───────────────────────────────

async function streamCompletion(
  messages: Groq.Chat.ChatCompletionMessageParam[],
  signal: AbortSignal,
  ctx: SessionContext,
  onEvent: GroqEventCallback,
): Promise<void> {
  const stream = await groq.chat.completions.create(
    {
      model: GROQ_MODEL,
      messages,
      stream: true,
      max_tokens: MAX_TOKENS,
      temperature: TEMPERATURE,
      ...(isReasoningModel(GROQ_MODEL) ? { reasoning_effort: REASONING_EFFORT } : {}),
    },
    { signal },
  );

  let fullText = '';
  let tokenIndex = 0;

  for await (const chunk of stream) {
    if (signal.aborted) break;

    const choice = chunk.choices[0];
    if (!choice) continue;

    const delta = choice.delta;
    const finishReason = choice.finish_reason;

    // ── Text delta ────────────────────────────────────────────
    if (delta?.content) {
      const text = delta.content;
      fullText += text;
      ctx.tokenCount++;

      onEvent({ type: 'llm_token', delta: text, tokenIndex });
      tokenIndex++;
    }

    // ── Tool call delta (Phase 5) ─────────────────────────────
    if (delta?.tool_calls && delta.tool_calls.length > 0) {
      const toolCall = delta.tool_calls[0];
      if (toolCall.function?.name) {
        onEvent({
          type: 'llm_tool_call',
          name: toolCall.function.name,
          args: toolCall.function.arguments ?? '',
        });
      }
    }

    // ── Stream complete ───────────────────────────────────────
    if (finishReason === 'stop' || finishReason === 'length') {
      // Append full assistant response to conversation history for multi-turn
      if (fullText.trim()) {
        ctx.conversationHistory.push({ role: 'assistant', content: fullText.trim() });
      }
      onEvent({ type: 'llm_stream_complete', fullText: fullText.trim() });
      console.log(`[groq] Stream complete — ${tokenIndex} tokens, finish=${finishReason}`);
      return;
    }
  }

  // Stream ended without explicit finish_reason (e.g. barge-in abort)
  if (fullText.trim()) {
    ctx.conversationHistory.push({ role: 'assistant', content: fullText.trim() });
  }
  onEvent({ type: 'llm_stream_complete', fullText: fullText.trim() });
}

// ── Utility ───────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
