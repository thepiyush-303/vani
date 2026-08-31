// ============================================================
// geminiStream.ts — Gemini LLM streaming integration using @google/genai
// v2.0: Adds Search Grounding, Todoist tool, and sanitizeForTTS.
// ============================================================

import { GoogleGenAI } from '@google/genai';
import { SessionContext } from './types';
import { todoistToolDeclaration } from './tools/todoist';
import { sanitizeForTTS } from './ttsUtils';
import { GroqEventCallback } from './groqStream'; // we reuse the callback type

// ── Gemini client singleton ───────────────────────────────────

const apiKey = process.env.GEMINI_API_KEY ?? '';
// Instantiate AI only if API key exists, otherwise we'll fail gracefully later
const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;

// User specified gemini-2.5-flash-lite in the request
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash-lite';

const SYSTEM_PROMPT = `You are Vani, a helpful and concise voice assistant. Your replies are spoken aloud.

SPEECH STYLE:
- For casual/factual questions: answer in 1-2 sentences maximum.
- Never use markdown, bullet points, lists, or URLs — speak naturally.
- Only give longer replies when the user asks for a story, explanation, or step-by-step instructions.

TOOL USE — CRITICAL RULES:
- You have access to: get_weather, add_todoist_task, and Google Search (grounding).
- ONLY call get_weather when the user EXPLICITLY asks about current weather or temperature for a specific place.
- ONLY call add_todoist_task when the user explicitly asks to add a reminder, task, or to-do item.
- For general knowledge and current events, rely on your Google Search grounding.
- NEVER call any tool for creative questions, stories, opinions, or anything that does not require real-time external data.
- If you are unsure whether to call a tool, DO NOT call it — just answer directly.
- NEVER read URLs, citation brackets like [1], or web addresses out loud.`;

let activeAbortController: AbortController | null = null;

export function abortGeminiStream(): void {
  if (activeAbortController) {
    activeAbortController.abort();
    activeAbortController = null;
    console.log('[gemini] Stream aborted (barge-in)');
  }
}

/**
 * Weather tool in Gemini functionDeclarations format.
 */
const geminiWeatherTool = {
  functionDeclarations: [
    {
      name: 'get_weather',
      description: 'Get the current weather in a given location',
      parameters: {
        type: 'OBJECT',
        properties: {
          location: {
            type: 'STRING',
            description: 'The city and state, e.g. San Francisco, CA',
          },
        },
        required: ['location'],
      },
    },
  ],
};

/**
 * Todoist tool in Gemini functionDeclarations format.
 * Bundled with weather in a single functionDeclarations array.
 */
const geminiFunctionTools = {
  functionDeclarations: [
    geminiWeatherTool.functionDeclarations[0],
    todoistToolDeclaration,
  ],
};

/**
 * Google Search Grounding tool (PRD_v2.md §B.2).
 * Mutually exclusive with tool_choice:"any" — always use auto (default).
 */
const googleSearchTool = { googleSearch: {} };

export async function startGeminiStream(
  ctx: SessionContext,
  onEvent: GroqEventCallback,
): Promise<void> {
  const MAX_RETRIES = 2;
  const RETRY_DELAY_MS = 1000;
  
  if (!ai) {
     console.error('[gemini] GEMINI_API_KEY is not set');
     onEvent({ type: 'llm_error', code: 'MISSING_API_KEY', msg: 'GEMINI_API_KEY is not set' });
     return;
  }

  if (ctx.conversationHistory.length === 0) {
    console.warn('[gemini] stream called with empty conversation history');
    onEvent({ type: 'llm_stream_complete', fullText: '' });
    return;
  }

  // Convert generic conversation history to Gemini 'contents' array
  const contents = ctx.conversationHistory.map((m) => {
    if (m.role === 'tool') {
      return {
        role: 'user', // For gemini SDK, tool result is passed as 'user' role with functionResponse
        parts: [{ 
            functionResponse: { 
                name: (m as any).tool_call_id || 'get_weather', 
                response: JSON.parse(m.content || '{}') 
            } 
        }],
      };
    }
    if (m.role === 'assistant' && (m as any).tool_calls && (m as any).tool_calls.length > 0) {
      const tc = (m as any).tool_calls[0].function;
      return {
        role: 'model',
        parts: [{
            functionCall: {
                name: tc.name,
                args: typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : tc.arguments,
            },
        }],
      };
    }
    return {
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content || '' }],
    };
  });

  console.log(`[gemini] Starting stream — model=${GEMINI_MODEL} history=${contents.length} msgs sent`);

  activeAbortController = new AbortController();
  const signal = activeAbortController.signal;

  let attempt = 0;
  let useTools = true; // Retry mechanism if tools crash
  
  while (attempt <= MAX_RETRIES) {
    try {
      await streamCompletion(contents, signal, ctx, onEvent, useTools);
      activeAbortController = null;
      return;
    } catch (err: any) {
      if (err.message === 'MODEL_TOOL_CRASH') {
        console.warn(`[gemini] Model returned 0 tokens. Retrying cleanly without tools (attempt ${attempt + 1})`);
        useTools = false;
        attempt++;
        continue;
      }
      
      if (err.name === 'AbortError' || signal.aborted) {
        console.log('[gemini] Stream cancelled by barge-in');
        activeAbortController = null;
        return;
      }
      
      if (err.status === 429 && attempt < MAX_RETRIES) {
        attempt++;
        console.warn(`[gemini] Rate limited (429) — retrying in ${RETRY_DELAY_MS}ms`);
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      
      console.error(`[gemini] Stream error: ${err.message}`);
      onEvent({ type: 'llm_error', code: 'GEMINI_ERROR', msg: err.message || 'Unknown Gemini error' });
      activeAbortController = null;
      return;
    }
  }
}

async function streamCompletion(
  contents: any[],
  signal: AbortSignal,
  ctx: SessionContext,
  onEvent: GroqEventCallback,
  useTools: boolean,
): Promise<void> {

  if (!ai) throw new Error('Gemini AI instance is null');

  const tools = useTools
    ? [googleSearchTool as any, geminiFunctionTools as any]
    : undefined;

  const stream = await ai.models.generateContentStream({
    model: GEMINI_MODEL,
    contents,
    config: {
      systemInstruction: SYSTEM_PROMPT,
      tools,
    },
  });

  let fullText = '';
  let tokenIndex = 0;
  let activeToolCall: { id: string; name: string; args: string } | null = null;
  
  let inThinkBlock = false;
  let thinkBuffer = '';

  // We need to capture the last chunk for groundingMetadata
  let lastChunk: any = null;

  for await (const chunk of stream) {
    if (signal.aborted) throw new Error('AbortError');
    lastChunk = chunk;
    
    // Check for tool calls natively
    if (chunk.functionCalls && chunk.functionCalls.length > 0) {
      const fc = chunk.functionCalls[0];
      const tcId = fc.name ?? 'unknown_tool';
      const tcName = fc.name ?? 'unknown_tool';
      const tcArgs = JSON.stringify(fc.args || {});

      activeToolCall = {
        id: tcId,
        name: tcName,
        args: tcArgs,
      };
      
      // Gemini usually returns tool calls completely in one go
      ctx.conversationHistory.push({
        role: 'assistant',
        content: '',
        tool_call_id: tcId,
      });
      const lastMsg = ctx.conversationHistory[ctx.conversationHistory.length - 1];
      (lastMsg as any).tool_calls = [{
        id: tcId,
        type: 'function',
        function: { name: tcName, arguments: tcArgs },
      }];
      
      onEvent({
        type: 'llm_tool_call',
        name: tcName,
        args: tcArgs,
        id: tcId,
      });
      console.log(`[gemini] Stream emitted tool call: ${tcName}`);
      return; // Stop stream processing because a tool is requested
    }

    if (chunk.text) {
      const text = chunk.text;
      
      if (inThinkBlock) {
        thinkBuffer += text;
        const endIdx = thinkBuffer.indexOf('</think>');
        if (endIdx !== -1) {
          inThinkBlock = false;
          const rest = thinkBuffer.slice(endIdx + 8);
          thinkBuffer = '';
          if (rest) {
            const clean = sanitizeForTTS(rest);
            if (clean) {
              fullText += clean;
              ctx.tokenCount++;
              onEvent({ type: 'llm_token', delta: clean, tokenIndex: tokenIndex++ });
            }
          }
        }
      } else {
        thinkBuffer += text;
        const startIdx = thinkBuffer.indexOf('<think>');
        
        if (startIdx !== -1) {
          const before = thinkBuffer.slice(0, startIdx);
          if (before) {
            const clean = sanitizeForTTS(before);
            if (clean) {
              fullText += clean;
              ctx.tokenCount++;
              onEvent({ type: 'llm_token', delta: clean, tokenIndex: tokenIndex++ });
            }
          }
          inThinkBlock = true;
          thinkBuffer = thinkBuffer.slice(startIdx + 7);
          
          const endIdx = thinkBuffer.indexOf('</think>');
          if (endIdx !== -1) {
             inThinkBlock = false;
             const after = thinkBuffer.slice(endIdx + 8);
             thinkBuffer = '';
             if (after) {
               const clean = sanitizeForTTS(after);
               if (clean) {
                 fullText += clean;
                 ctx.tokenCount++;
                 onEvent({ type: 'llm_token', delta: clean, tokenIndex: tokenIndex++ });
               }
             }
          }
        } else {
          // Check trailing buffer for partial <think> tag
          let holdIdx = -1;
          for (let i = thinkBuffer.length - 1; i >= Math.max(0, thinkBuffer.length - 7); i--) {
            if (thinkBuffer[i] === '<' && '<think>'.startsWith(thinkBuffer.slice(i))) {
              holdIdx = i;
              break;
            }
          }
          
          if (holdIdx !== -1) {
            const before = thinkBuffer.slice(0, holdIdx);
            if (before) {
              const clean = sanitizeForTTS(before);
              if (clean) {
                fullText += clean;
                ctx.tokenCount++;
                onEvent({ type: 'llm_token', delta: clean, tokenIndex: tokenIndex++ });
              }
            }
            thinkBuffer = thinkBuffer.slice(holdIdx);
          } else {
            const clean = sanitizeForTTS(thinkBuffer);
            if (clean) {
              fullText += clean;
              ctx.tokenCount++;
              onEvent({ type: 'llm_token', delta: clean, tokenIndex: tokenIndex++ });
            }
            thinkBuffer = '';
          }
        }
      }
    }
  }

  // ── Stream done: extract Grounding metadata (PRD_v2.md §B.3) ──
  // groundingMetadata is on the final candidate — check the last chunk.
  if (lastChunk) {
    const candidate = lastChunk.candidates?.[0];
    const meta = candidate?.groundingMetadata;
    if (meta) {
      console.log('[gemini] [grounding] queries:', meta.webSearchQueries);
      console.log('[gemini] [grounding] sources:', meta.groundingChunks?.map((c: any) => c.web?.uri));

      // Emit a new internal event so sideEffects.ts can broadcast it to the client WS
      onEvent({
        type: 'grounding_sources',
        queries: meta.webSearchQueries ?? [],
        sources: (meta.groundingChunks ?? []).map((c: any) => ({
          title: c.web?.title ?? '',
          uri: c.web?.uri ?? '',
        })),
      } as any);
    }
  }

  // Stream successfully finished
  if (fullText.trim().length === 0 && !activeToolCall && !signal.aborted) {
    throw new Error('MODEL_TOOL_CRASH');
  }

  if (fullText.trim()) {
    ctx.conversationHistory.push({ role: 'assistant', content: fullText.trim() });
    onEvent({ type: 'llm_stream_complete', fullText: fullText.trim() });
    console.log(`[gemini] Stream complete — ${tokenIndex} tokens`);
  }
}
