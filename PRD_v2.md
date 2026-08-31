# PRD Addendum — Version 2.0
### Extends: PRD.md (Version 1.0)
**Date:** 2026-08-31 | **Status:** APPROVED FOR IMPLEMENTATION
**Scope:** Three net-new feature areas: (A) Alexa-Style Wake Word, (B) Native Google Search Grounding, (C) Todoist Task Creation Tool.

> **NOTE:** This document is additive. All specifications within PRD.md v1.0 remain in full effect. Where this document conflicts with v1.0, v2.0 takes precedence.

---

## Table of Contents

- [A. Wake Word Detection — Porcupine WebAssembly](#a-wake-word-detection--porcupine-webassembly)
- [B. Native Google Search Grounding](#b-native-google-search-grounding)
- [C. Todoist Task Creation Tool](#c-todoist-task-creation-tool)

---

## A. Wake Word Detection — Porcupine WebAssembly

### A.1 Motivation & Architecture Overview

The v1.0 client boots directly into an **always-on VAD** posture, meaning Silero VAD is running continuously and the WebSocket connection is open immediately. This is wasteful for battery, CPU, and introduces unnecessary idle noise into the LLM context. Version 2.0 introduces a two-layer detection hierarchy:

```
Layer 1 (always-on, offline):   Porcupine WASM  →  detects "Hey Vani" or chosen keyword
Layer 2 (on-demand, online):    Silero VAD      →  captures the actual user command
WebSocket:                       Closed until wake → Opens only after wake word detected
```

The client now has a persistent **ASLEEP** state that exists entirely before any WebSocket connection is established. The WebSocket lifecycle is entirely gated by wake word detection.

### A.2 Library & Package

| Item | Value |
|---|---|
| **npm Package** | `@picovoice/porcupine-web` |
| **Runtime** | WebAssembly (`.wasm` bundle compiled by Picovoice) |
| **Keyword File** | `.ppn` binary model file (obtained from Picovoice Console — free tier supports one custom wake word) |
| **Access Key** | `PICOVOICE_ACCESS_KEY` — obtained from [console.picovoice.ai](https://console.picovoice.ai), stored as an env var and injected at build time |

**Installation:**
```bash
npm install @picovoice/porcupine-web
```

The WASM binary is loaded directly by the library. The keyword `.ppn` file and the `PorcupineModel` WASM blob must be hosted as static assets (e.g., in `/public/porcupine/`).

### A.3 Client State Machine Extension

The v2.0 client state machine extends the v1.0 server-side states with new client-only states:

```
ASLEEP        → Porcupine active, Silero inactive, WebSocket CLOSED
WAKING        → Wake word detected; WS opening; chime playing; Silero initializing
LISTENING     → Silero VAD active, PCM streaming to server (mirrors server LISTENING)
[...rest of states mirror v1.0 server states...]
```

**State Transition: ASLEEP → WAKING → LISTENING**

```
┌────────────────────────────────────────────────────────────┐
│                       ASLEEP                               │
│  Porcupine.process(pcmFrame) on every 512-sample frame     │
│  AudioContext: 16kHz, ScriptProcessorNode / AudioWorklet   │
└────────────────────────┬───────────────────────────────────┘
                         │ onWakeWordDetected callback fires
                         ▼
┌────────────────────────────────────────────────────────────┐
│                       WAKING                               │
│  1. Porcupine.pause() — stop wake word polling             │
│  2. Open WebSocket → ws = new WebSocket(SERVER_URL)        │
│  3. Play listening chime (see §A.5)                        │
│  4. On ws.onopen: send session_init message                │
│  5. Initialize Silero VAD (MicVAD.create({...}))           │
│  6. Transition to LISTENING on first VAD speech_start      │
└────────────────────────────────────────────────────────────┘
                         │ ws.onopen + VAD ready
                         ▼
                      LISTENING
```

**Return to ASLEEP** (after `turn_complete` or inactivity timeout):
```
1. Silero VAD.destroy()
2. ws.close()
3. Porcupine.resume()   ← back to passive keyword scanning
4. Client state → ASLEEP
```

### A.4 Porcupine Integration Code

```typescript
import { PorcupineWorker } from '@picovoice/porcupine-web';

// Keyword file served from /public/porcupine/hey-vani_en_wasm.ppn
const KEYWORD_URL  = '/porcupine/hey-vani_en_wasm.ppn';
const MODEL_URL    = '/porcupine/porcupine_params.pv';  // base English model
const ACCESS_KEY   = process.env.VITE_PICOVOICE_ACCESS_KEY!;

async function initPorcupine(): Promise<PorcupineWorker> {
  const porcupine = await PorcupineWorker.create(
    ACCESS_KEY,
    { publicPath: KEYWORD_URL, label: 'hey-vani' },  // custom keyword descriptor
    handleWakeWord,
    { publicPath: MODEL_URL }
  );
  await porcupine.start();  // begins feeding mic frames to WASM
  return porcupine;
}

function handleWakeWord(detection: WakeWordDetection): void {
  if (detection.label === 'hey-vani') {
    transitionToWaking();  // defined in §A.3
  }
}
```

> **CRITICAL:** Porcupine operates on a separate `AudioContext` with a dedicated `ScriptProcessorNode` / `AudioWorkletNode`. Do NOT share the Silero VAD's AudioContext with Porcupine — they use different sample rate constraints. Feed Porcupine raw 16kHz 512-sample PCM frames from a dedicated worklet.

> **CRITICAL:** `PorcupineWorker.create()` is the preferred async factory. Do NOT use `new PorcupineWorker()` directly — it does not await WASM initialization. Calling `.process()` before `.start()` will throw.

### A.5 Listening Chime — Web Audio API

When the wake word is detected, a brief auditory confirmation plays **before** any server interaction. This is synthesized entirely client-side via the Web Audio API with zero network latency.

```typescript
function playListeningChime(ctx: AudioContext): void {
  // Two-note ascending chime: 880Hz → 1046Hz  (A5 → C6)
  const notes = [880, 1046.5];
  let startTime = ctx.currentTime;

  for (const freq of notes) {
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type      = 'sine';
    osc.frequency.setValueAtTime(freq, startTime);

    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(0.4, startTime + 0.02);   // 20ms attack
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.15); // 130ms decay

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(startTime);
    osc.stop(startTime + 0.15);

    startTime += 0.12;  // 120ms between notes
  }
}
```

The chime AudioContext MUST be the **playback** context running at 22050 Hz (matching Piper TTS output) — NOT the capture context.

### A.6 Inactivity Timeout & Auto-Sleep

After `turn_complete` is received, a 30-second inactivity timer begins. If no new `speech_start` arrives within that window, the client auto-transitions back to `ASLEEP`.

```typescript
const INACTIVITY_MS = 30_000;
let inactivityTimer: ReturnType<typeof setTimeout> | null = null;

function onTurnComplete(): void {
  inactivityTimer = setTimeout(() => {
    transitionToAsleep();
  }, INACTIVITY_MS);
}

function onSpeechStart(): void {
  if (inactivityTimer) {
    clearTimeout(inactivityTimer);
    inactivityTimer = null;
  }
}
```

### A.7 New WebSocket Message: `wake_word_detected`

Add the following **client → server** message. The server uses this for logging and analytics only — it does NOT change the server state machine.

```json
{
  "type": "wake_word_detected",
  "session_id": "string (UUID v4)",
  "keyword": "hey-vani",
  "confidence": "number (0.0–1.0)",
  "timestamp_ms": "number (epoch ms)"
}
```

---

## B. Native Google Search Grounding

### B.1 Motivation

The v1.0 backend uses a `search_browser` function tool (§4.6 of PRD.md) that dispatches to an external search API and re-injects results into the LLM context. This adds **one full round-trip** (~200–500ms). With the Gemini API's native **Grounding with Google Search**, the model fetches and cites live web results internally in a single `generateContent` call, eliminating the external tool hop entirely.

> **ARCHITECTURE CHANGE:** With Gemini Search Grounding enabled, the `search_browser` tool definition (§4.6) is **superseded**. Remove it from the `tools` array when Gemini is the active LLM provider. The model handles web search natively.

### B.2 Gemini API Configuration

The `@google/genai` SDK exposes Search Grounding as a built-in tool. Pass it in the `tools` array alongside any function declarations:

```typescript
import { GoogleGenAI, Tool } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Tool array: Google Search grounding + your function tools
const tools: Tool[] = [
  { googleSearch: {} },            // ← enables native Search Grounding
  TOOL_ORDER_FOOD,                 // your existing function tool declarations
  TOOL_BOOK_FLIGHT,
  TOOL_GET_WEATHER,
  TOOL_GET_NEWS,
  TOOL_ADD_TODOIST_TASK,           // new in v2.0
];

const response = await ai.models.generateContentStream({
  model: 'gemini-2.5-flash-lite',
  contents: conversationHistory,
  config: {
    tools,
    temperature: 0.3,
    maxOutputTokens: 512,
  },
});
```

> **IMPORTANT:** `{ googleSearch: {} }` takes an empty object. Do NOT pass any query — the model decides when and what to search autonomously based on the user's prompt.

> **IMPORTANT:** Google Search Grounding is **mutually exclusive** with `tool_choice: "any"`. When grounding is active, always use `tool_choice: "auto"` (the default). Forcing a specific function tool alongside grounding will cause a 400 API error.

### B.3 Parsing `groundingMetadata`

When the model uses Search Grounding, the API response includes a `groundingMetadata` object on the `Candidate`. This metadata contains rendered search suggestions and source URLs intended for display purposes — **it must NOT be read aloud by TTS**.

**Response structure to parse:**
```typescript
interface GroundingMetadata {
  webSearchQueries?: string[];        // queries the model issued
  searchEntryPoint?: {
    renderedContent: string;          // HTML snippet for "Google Search" badge
  };
  groundingChunks?: Array<{
    web: {
      uri: string;                    // source URL
      title: string;                  // page title
    };
  }>;
  groundingSupports?: Array<{
    segment: { text: string };        // text segment that was grounded
    groundingChunkIndices: number[];  // indices into groundingChunks[]
    confidenceScores: number[];
  }>;
}
```

**Server-side extraction pattern:**
```typescript
async function processGeminiStream(stream: AsyncIterable<GenerateContentResponse>) {
  let fullText = '';

  for await (const chunk of stream) {
    // 1. Extract and pipe text delta to TTS sentence buffer (as before)
    const textDelta = chunk.text();
    if (textDelta) {
      fullText += textDelta;
      pipeToSentenceBuffer(textDelta);
    }

    // 2. Extract grounding metadata — present on the FINAL chunk only
    const candidate = chunk.candidates?.[0];
    if (candidate?.groundingMetadata) {
      const meta = candidate.groundingMetadata;

      // Log for analytics/debugging — do NOT send to TTS
      console.log('[grounding] queries:', meta.webSearchQueries);
      console.log('[grounding] sources:', meta.groundingChunks?.map(c => c.web.uri));

      // Optionally: emit a structured WS event to the client for display
      broadcastToClient({
        type: 'grounding_sources',
        session_id: currentSessionId,
        queries: meta.webSearchQueries ?? [],
        sources: meta.groundingChunks?.map(c => ({
          title: c.web.title,
          uri: c.web.uri,
        })) ?? [],
        timestamp_ms: Date.now(),
      });
    }
  }
}
```

### B.4 New WebSocket Message: `grounding_sources` (Server → Client)

```json
{
  "type": "grounding_sources",
  "session_id": "string",
  "queries": ["string"],
  "sources": [
    {
      "title": "string",
      "uri": "string (URL)"
    }
  ],
  "timestamp_ms": "number"
}
```

The client renders these as a non-intrusive visual attribution panel (e.g., "Sourced from: [title] ...") beneath the transcript display. They are displayed-only and never injected into the TTS pipeline.

### B.5 TTS Content Cleanliness Rules

The following patterns MUST be stripped from text before it reaches the Piper TTS sentence buffer:

| Pattern | Action |
|---|---|
| Bare URLs (`https://...`) | Strip entirely |
| Markdown links (`[text](url)`) | Replace with `text` only |
| Citation brackets (`[1]`, `[2,3]`) | Strip entirely |
| HTML tags (`<...>`) | Strip entirely |
| `renderedContent` HTML blob | Never pipe to TTS — route to client only |

**Sanitization function:**
```typescript
function sanitizeForTTS(text: string): string {
  return text
    .replace(/https?:\/\/[^\s)>\"]+/g, '')        // strip bare URLs
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')       // markdown links → text only
    .replace(/\[\d+(,\s*\d+)*\]/g, '')             // citation refs
    .replace(/<[^>]*>/g, '')                        // HTML tags
    .replace(/\s{2,}/g, ' ')                        // collapse whitespace
    .trim();
}
```

---

## C. Todoist Task Creation Tool

### C.1 Tool Definition: `add_todoist_task`

This tool enables the agent to create tasks in the user's Todoist inbox via the Todoist REST API v2. It leverages Todoist's built-in **Natural Language Processing (NLP)** engine by passing the raw user date/time string directly — the API parses it server-side (e.g., `"Drink milk at 7:00 PM"` → due date + time set automatically).

```json
{
  "type": "function",
  "function": {
    "name": "add_todoist_task",
    "description": "Create a new task in the user's Todoist. Use this when the user wants to add a reminder, to-do, or task. Pass the user's raw time expression (e.g., 'tomorrow at 3pm', 'every Monday') directly — Todoist will parse it automatically. Do NOT pre-convert time expressions to ISO dates.",
    "parameters": {
      "type": "object",
      "properties": {
        "content": {
          "type": "string",
          "description": "The task name. This is the main text of the task. Keep it concise and action-oriented (e.g., 'Drink milk', 'Call dentist', 'Submit quarterly report'). Maximum 500 characters.",
          "minLength": 1,
          "maxLength": 500
        },
        "due_string": {
          "type": "string",
          "description": "A natural language due date/time string. Pass the user's raw expression verbatim (e.g., 'tomorrow at 9am', 'every weekday', 'next Friday at 5pm', 'Aug 31 at 7pm'). Todoist's NLP engine parses this. Do NOT convert to ISO format.",
          "maxLength": 200
        },
        "priority": {
          "type": "integer",
          "description": "Task priority. 1 = normal (default), 2 = medium, 3 = high, 4 = urgent. Infer from user language: 'important'/'urgent' → 4; 'high priority' → 3; unspecified → 1.",
          "enum": [1, 2, 3, 4],
          "default": 1
        },
        "description": {
          "type": "string",
          "description": "Optional additional notes or context to attach to the task body. Use when the user provides extra details beyond the task name.",
          "maxLength": 1000
        },
        "labels": {
          "type": "array",
          "description": "Optional list of label names to apply to the task (e.g., ['work', 'health']). Labels must already exist in the user's Todoist account.",
          "items": {
            "type": "string",
            "maxLength": 60
          },
          "maxItems": 10
        }
      },
      "required": ["content"],
      "additionalProperties": false
    }
  }
}
```

### C.2 Backend Execution — Todoist REST API v2

**Endpoint:** `POST https://api.todoist.com/rest/v2/tasks`

**Authentication:** Bearer token — `TODOIST_API_TOKEN` environment variable (user's personal API token from `todoist.com/app/settings/integrations/developer`).

**Idempotency:** Generate a `X-Request-Id` UUID per call to prevent duplicate task creation on retry.

```typescript
import { randomUUID } from 'crypto';

const TODOIST_API_URL = 'https://api.todoist.com/rest/v2/tasks';
const TODOIST_TOKEN   = process.env.TODOIST_API_TOKEN!;

interface TodoistTaskPayload {
  content:      string;
  due_string?:  string;
  due_lang?:    string;   // 'en' — ensures NLP uses English parser
  priority?:    1 | 2 | 3 | 4;
  description?: string;
  labels?:      string[];
}

interface TodoistTaskResult {
  id:          string;
  content:     string;
  due?:        { string: string; date: string; datetime?: string };
  priority:    number;
  url:         string;
}

async function executeTodoistTool(args: {
  content: string;
  due_string?: string;
  priority?: 1 | 2 | 3 | 4;
  description?: string;
  labels?: string[];
}): Promise<{ success: boolean; task?: TodoistTaskResult; error?: string }> {

  const payload: TodoistTaskPayload = {
    content:     args.content,
    priority:    args.priority ?? 1,
    due_lang:    'en',  // ALWAYS set; ensures Todoist NLP uses English parser
  };

  // Only include optional fields if provided
  if (args.due_string)   payload.due_string   = args.due_string;
  if (args.description)  payload.description  = args.description;
  if (args.labels?.length) payload.labels     = args.labels;

  try {
    const res = await fetch(TODOIST_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TODOIST_TOKEN}`,
        'Content-Type':  'application/json',
        'X-Request-Id':  randomUUID(),  // idempotency key
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(4000),  // 4s hard timeout
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Todoist API ${res.status}: ${errBody}`);
    }

    const task: TodoistTaskResult = await res.json();
    return { success: true, task };

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}
```

### C.3 LLM Tool Result Injection

After successful execution, inject the result back into the Gemini conversation as a `function` role message:

**Success result (inject into `contents` history):**
```typescript
{
  role: 'function',
  parts: [{
    functionResponse: {
      name: 'add_todoist_task',
      response: {
        success: true,
        task_id: task.id,
        content: task.content,
        due: task.due?.string ?? 'No due date',  // human-readable string
        url: task.url,
      }
    }
  }]
}
```

**The model then generates a confirmation phrase like:**
> *"Done! I've added 'Drink milk' to your Todoist, due today at 7 PM."*

This confirmation is what gets piped to Piper TTS. The `task.url` is **never** read aloud (see §B.5 TTS sanitization rules).

**Failure result:**
```typescript
{
  role: 'function',
  parts: [{
    functionResponse: {
      name: 'add_todoist_task',
      response: {
        success: false,
        error: 'Todoist API 401: Invalid token',
        suggestion: 'Check that TODOIST_API_TOKEN is set correctly in your environment.',
      }
    }
  }]
}
```

### C.4 Validation Rules (Server-Side)

| Check | On Failure |
|---|---|
| `content` length ≥ 1 | Reject; TTS: *"What would you like to name the task?"* |
| `content` length ≤ 500 | Truncate at 500 chars; proceed |
| `TODOIST_API_TOKEN` is set in env | Reject; TTS: *"Todoist isn't configured yet."*; log `ERROR: TODOIST_API_TOKEN missing` |
| API returns 401 | TTS: *"I don't have permission to access your Todoist."* |
| API returns 429 | Retry after `Retry-After` header seconds (max 1 retry); if still 429, TTS: *"Todoist is a bit busy right now."* |
| `ABORT_ERR` / timeout | TTS: *"I couldn't reach Todoist right now. Please try again."* |

### C.5 Environment Variables

Add to `.env` / server environment:

```env
TODOIST_API_TOKEN=your_personal_api_token_here
```

Add to `.env.example`:
```env
TODOIST_API_TOKEN=           # Get from: https://todoist.com/app/settings/integrations/developer
```

---

## D. Latency Budget Update (v2.0)

The three new features have the following latency implications:

| Feature | Path Impact | Latency Delta |
|---|---|---|
| **Wake Word (Porcupine)** | Runs entirely offline in browser WASM; zero network cost. Chime is ~250ms Web Audio playback *before* WS opens — adds perceived ~250ms pre-command. No impact on main SLA path. | +0ms to SLA |
| **Search Grounding (Gemini)** | Grounding is performed inside a single `generateContent` call. Replaces the external `search_browser` tool call. Net change: eliminates one tool round-trip (~200–500ms). TTFT may increase slightly (~50–100ms) as Gemini internally fetches results. | **−100 to −400ms** on search queries |
| **Todoist Tool** | Uses the tool execution path (§4.7 of PRD.md). Todoist REST API v2 P50 response is ~150ms. Well within the 500ms tool budget. | +0ms (within budget) |

---

## E. State Machine Addendum (v2.0 Client States)

The following states are added to the **client-only** state machine. Server state machine is unchanged.

| State | Description | Active Processes |
|---|---|---|
| `ASLEEP` | Default boot state. No WS connection. | Porcupine WASM polling mic at 512 samples/frame |
| `WAKING` | Wake word detected. Transitioning to active mode. | Porcupine paused; WS opening; chime playing; VAD initializing |
| `IDLE` (v2.0) | WS open; VAD ready; waiting for speech. | Silero VAD listening; Porcupine paused |
| *(On turn_complete or 30s timeout)* | → Return to `ASLEEP` | Silero destroyed; WS closed; Porcupine resumed |
