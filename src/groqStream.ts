// ============================================================
// groqStream.ts — Groq LLM streaming integration
// PRD §4: chat LLM via Groq LPU, streaming (model set by GROQ_MODEL env)
// ============================================================

import Groq from 'groq-sdk';
import WebSocket from 'ws';
import { SessionContext } from './types';
import { weatherToolDefinition } from './tools/weather';

// ── Groq client singleton ─────────────────────────────────────

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY ?? '',
});

const GROQ_MODEL = process.env.GROQ_MODEL ?? 'qwen/qwen3.6-27b';
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

const SYSTEM_PROMPT = `You are a helpful, concise voice assistant. Your replies are spoken aloud.

SPEECH STYLE:
- For casual/factual questions: answer in 1-2 sentences maximum.
- Never use markdown, bullet points, or lists — speak naturally.
- Only give longer replies when the user asks for a story, explanation, or step-by-step instructions.

TOOL USE — CRITICAL RULE:
- You have access to a get_weather tool.
- ONLY call get_weather when the user EXPLICITLY asks about current weather or temperature for a specific place.
- NEVER call any tool for creative questions, stories, general knowledge, jokes, opinions, or anything that does not require real-time external data.
- If you are unsure whether to call a tool, DO NOT call it — just answer directly.`;

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
    | { type: 'llm_tool_call'; name: string; args: string; id: string }
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

  // Build message array with system prompt prepended.
  // IMPORTANT: we must correctly serialize all 4 message types:
  //   1. user   — plain text
  //   2. assistant — plain text response
  //   3. assistant — with tool_calls array (the model's tool invocation request)
  //   4. tool   — tool execution result (has tool_call_id)
  const messages: Groq.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...ctx.conversationHistory.map((m) => {
      if (m.role === 'tool') {
        return {
          role: 'tool' as const,
          content: m.content ?? '',
          tool_call_id: (m as any).tool_call_id as string,
        };
      }
      if (m.role === 'assistant' && (m as any).tool_calls) {
        // Preserve the tool_calls array so Groq knows which call this is a response to
        return {
          role: 'assistant' as const,
          content: m.content ?? null,
          tool_calls: (m as any).tool_calls,
        };
      }
      return {
        role: m.role as 'user' | 'assistant',
        content: m.content ?? '',
      };
    }),
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
      tools: [weatherToolDefinition],
      tool_choice: 'auto',  // let model decide, but guided by strict system prompt
      ...(isReasoningModel(GROQ_MODEL) ? { reasoning_effort: REASONING_EFFORT } : {}),
    },
    { signal },
  );

  let fullText = '';
  let tokenIndex = 0;
  let activeToolCall: { id: string; name: string; args: string } | null = null;

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
      const tc = delta.tool_calls[0];
      if (tc.id && tc.function?.name) {
        // Start of a new tool call
        activeToolCall = {
          id: tc.id,
          name: tc.function.name,
          args: tc.function.arguments ?? '',
        };
      } else if (activeToolCall && tc.function?.arguments) {
        // Continuation of tool call arguments
        activeToolCall.args += tc.function.arguments;
      }
    }

    if (activeToolCall && (finishReason === 'tool_calls' || finishReason === 'stop')) {
      // Tool call fully streamed — emit and append to history so the assistant's turn is tracked
      ctx.conversationHistory.push({
        role: 'assistant',
        content: '',
        tool_call_id: activeToolCall.id,
      });
      // Hack to ensure groq allows it: standard API expects `tool_calls` in history
      const lastMsg = ctx.conversationHistory[ctx.conversationHistory.length - 1];
      (lastMsg as any).tool_calls = [{
        id: activeToolCall.id,
        type: 'function',
        function: { name: activeToolCall.name, arguments: activeToolCall.args }
      }];
      delete lastMsg.tool_call_id; // remove fake key

      onEvent({
        type: 'llm_tool_call',
        name: activeToolCall.name,
        args: activeToolCall.args,
        id: activeToolCall.id,
      });
      console.log(`[groq] Stream complete — tool call requested: ${activeToolCall.name}`);
      return;
    }

    // ── Stream complete ───────────────────────────────────────
    if (finishReason === 'stop' || finishReason === 'length') {
      if (!activeToolCall) {
        // Append full assistant response to conversation history for multi-turn
        if (fullText.trim()) {
          ctx.conversationHistory.push({ role: 'assistant', content: fullText.trim() });
        }
        onEvent({ type: 'llm_stream_complete', fullText: fullText.trim() });
        console.log(`[groq] Stream complete — ${tokenIndex} tokens, finish=${finishReason}`);
        return;
      }
    }
  }

  // Stream ended without explicit finish_reason (e.g. barge-in abort)
  if (fullText.trim()) {
    ctx.conversationHistory.push({ role: 'assistant', content: fullText.trim() });
  }
  if (!activeToolCall) {
    onEvent({ type: 'llm_stream_complete', fullText: fullText.trim() });
  }
}

// ── Utility ───────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
