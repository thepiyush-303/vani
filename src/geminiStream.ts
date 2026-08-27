// ============================================================
// geminiStream.ts — Gemini LLM streaming integration using @google/genai
// ============================================================

import { GoogleGenAI } from '@google/genai';
import { SessionContext } from './types';
import { weatherToolDefinition } from './tools/weather';
import { GroqEventCallback } from './groqStream'; // we reuse the callback type

// ── Gemini client singleton ───────────────────────────────────

const apiKey = process.env.GEMINI_API_KEY ?? '';
// Instantiate AI only if API key exists, otherwise we'll fail gracefully later
const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;

// User specified gemini-2.5-flash-lite in the request
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash-lite';

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

let activeAbortController: AbortController | null = null;

export function abortGeminiStream(): void {
  if (activeAbortController) {
    activeAbortController.abort();
    activeAbortController = null;
    console.log('[gemini] Stream aborted (barge-in)');
  }
}

/**
 * We map the function declaration format specifically for Gemini.
 */
const geminiWeatherTool = {
  functionDeclarations: [
    {
      name: "get_weather",
      description: "Get the current weather in a given location",
      parameters: {
        type: "OBJECT",
        properties: {
          location: {
            type: "STRING",
            description: "The city and state, e.g. San Francisco, CA",
          },
        },
        required: ["location"],
      },
    }
  ]
};

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
        role: 'user', // For gemini SDK, tool result is typically passed as 'user' role with part.functionResponse or natively handling functionResponse
        parts: [{ 
            functionResponse: { 
                name: (m as any).tool_call_id || "get_weather", 
                response: JSON.parse(m.content || '{}') 
            } 
        }]
      };
    }
    if (m.role === 'assistant' && (m as any).tool_calls && (m as any).tool_calls.length > 0) {
      const tc = (m as any).tool_calls[0].function;
      return {
        role: 'model',
        parts: [{
            functionCall: {
                name: tc.name,
                args: typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : tc.arguments
            }
        }]
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

  if (!ai) throw new Error("Gemini AI instance is null");

  const stream = await ai.models.generateContentStream({
    model: GEMINI_MODEL,
    contents,
    config: {
      systemInstruction: SYSTEM_PROMPT,
      tools: useTools ? [geminiWeatherTool] as any : undefined,
    }
  });

  let fullText = '';
  let tokenIndex = 0;
  let activeToolCall: { id: string; name: string; args: string } | null = null;
  
  let inThinkBlock = false;
  let thinkBuffer = '';

  for await (const chunk of stream) {
    if (signal.aborted) throw new Error('AbortError');
    
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
      
      // Gemini usually returns tool calls completely in one go, unlike Groq's token delta stream
      ctx.conversationHistory.push({
        role: 'assistant',
        content: '',
        tool_call_id: tcId,
      });
      // Mock for standard SDK
      const lastMsg = ctx.conversationHistory[ctx.conversationHistory.length - 1];
      (lastMsg as any).tool_calls = [{
        id: tcId,
        type: 'function',
        function: { name: tcName, arguments: tcArgs }
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
             fullText += rest;
             ctx.tokenCount++;
             onEvent({ type: 'llm_token', delta: rest, tokenIndex: tokenIndex++ });
          }
        }
      } else {
        thinkBuffer += text;
        const startIdx = thinkBuffer.indexOf('<think>');
        
        if (startIdx !== -1) {
          const before = thinkBuffer.slice(0, startIdx);
          if (before) {
             fullText += before;
             ctx.tokenCount++;
             onEvent({ type: 'llm_token', delta: before, tokenIndex: tokenIndex++ });
          }
          inThinkBlock = true;
          thinkBuffer = thinkBuffer.slice(startIdx + 7);
          
          const endIdx = thinkBuffer.indexOf('</think>');
          if (endIdx !== -1) {
             inThinkBlock = false;
             const after = thinkBuffer.slice(endIdx + 8);
             thinkBuffer = '';
             if (after) {
                fullText += after;
                ctx.tokenCount++;
                onEvent({ type: 'llm_token', delta: after, tokenIndex: tokenIndex++ });
             }
          }
        } else {
          // Check trailing buffer
          let holdIdx = -1;
          for (let i = thinkBuffer.length - 1; i >= Math.max(0, thinkBuffer.length - 7); i--) {
            if (thinkBuffer[i] === '<' && "<think>".startsWith(thinkBuffer.slice(i))) {
              holdIdx = i;
              break;
            }
          }
          
          if (holdIdx !== -1) {
             const before = thinkBuffer.slice(0, holdIdx);
             if (before) {
                fullText += before;
                ctx.tokenCount++;
                onEvent({ type: 'llm_token', delta: before, tokenIndex: tokenIndex++ });
             }
             thinkBuffer = thinkBuffer.slice(holdIdx);
          } else {
             fullText += thinkBuffer;
             ctx.tokenCount++;
             onEvent({ type: 'llm_token', delta: thinkBuffer, tokenIndex: tokenIndex++ });
             thinkBuffer = '';
          }
        }
      }
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
