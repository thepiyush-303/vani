# Project Progress Tracker

## CURRENT STATUS
**Version 2.0 — Phase 5 (Tool Calling)** in progress. Phases 1–4 complete. v2.0 feature phases (8–10) added per `PRD_v2.md`.

**Latency pass (2026-08-26):** application-level response-latency optimizations landed (no model change): Groq history capped to last 8 msgs to bound prefill/TTFT; sentence buffer flushes the first chunk on a shorter 60ms timeout for faster first-audio; Whisper `condition_on_previous_text=False`; real per-stage `[latency]` server logs (STT wall, Groq TTFT, perceived). Structural floor remains STT `base.en` (~850ms) + Groq free-tier TTFT (~1s) — strict <1000ms needs the `tiny.en` STT toggle (accuracy tradeoff) or a faster LLM. See `memory/vani_latency_budget.md`.

**v2.0 addendum (2026-08-31):** Three new features specified in `PRD_v2.md`: Porcupine wake word (ASLEEP state), Gemini native Search Grounding (replaces `search_browser` tool), Todoist REST API v2 task creation tool.

---

## Phase 1: Basic Node Server & WebSocket Setup
- [x] Initialize Node.js project and install dependencies (`ws`, etc.).
- [x] Implement robust WebSocket server with `session_init` handshake.
- [x] Set up binary frame detection and routing for text JSON vs. binary PCM payloads.
- [x] Implement the core server state machine (IDLE, LISTENING, TRANSCRIBING, LLM_STREAMING, TTS_STREAMING, BARGE_IN_INTERRUPTED, TOOL_EXECUTING).

## Phase 2: Client VAD & Audio Capture Implementation
- [x] Set up browser-based microphone capture using Web Audio API.
- [x] Implement client-side 16kHz resampling via `AudioWorkletNode` or `OfflineAudioContext`.
- [x] Integrate `@ricky0123/vad-web` (Silero VAD) with optimized parameters.
- [x] Stream binary PCM audio chunks from client VAD to WebSocket server.

## Phase 3: Whisper STT & Piper TTS Subprocess Integration
- [x] Create persistent `faster_whisper_server.py` subprocess with length-prefixed stdin protocol.
- [x] Route incoming WebSocket PCM streams to Whisper subprocess.
- [x] Set up persistent Piper TTS subprocess taking JSON-line stdin and outputting raw PCM.
- [x] Implement sentence boundary buffering for Piper text input chunks.

## Phase 4: LLM Integration & Event Orchestration
- [x] Connect Groq API (Llama 3.1) for LLM streaming completions.
- [x] Pipe partial and final Whisper transcripts to the Groq LLM context.
- [x] Route Groq LLM text deltas through the sentence buffer to Piper TTS.
- [x] Stream synthesized chunks from Piper back to the client WebSocket.

## Phase 5: Tool Calling Contracts & Execution
- [ ] Register `order_food`, `book_flight`, `get_weather`, `get_news`, and `search_browser` tool definitions with Groq.
- [ ] Implement server-side tool argument validation.
- [ ] Build tool execution logic with 500ms timeout fallback and retry handler.
- [ ] Implement synthetic tool error injection and LLM stream continuation.

## Phase 6: Advanced Features (Barge-in & Pre-fetching)
- [ ] Develop non-LLM regex intent classifier for predictive pre-fetching.
- [ ] Integrate MCP pre-fetch worker thread for pre-warming APIs.
- [ ] Implement barge-in detection (sub-60ms state interruption).
- [ ] Create hot-standby Piper process swapping for instant barge-in recovery.

## Phase 7: Hardening & End-to-End Testing
- [ ] Add conversation history token estimation and pruning logic.
- [ ] Implement fault-isolation and subprocess crash recovery (automatic restarts).
- [ ] Add rate-limit backoffs (429) and 503 fallback mechanisms for Groq API.
- [ ] Write integration test (Speak → STT → LLM → TTS Playback) and measure against <800ms latency budget.

---

## Phase 8: Wake Word Detection (Porcupine WASM) — v2.0
- [ ] Install `@picovoice/porcupine-web`; obtain Picovoice Access Key; download `.ppn` keyword model for "Hey Vani" from Picovoice Console.
- [ ] Host `hey-vani_en_wasm.ppn` and `porcupine_params.pv` as static assets in `/public/porcupine/`.
- [ ] Create dedicated `AudioWorkletNode` (16kHz, 512-sample frames) exclusively for Porcupine — do NOT share with Silero VAD.
- [ ] Implement `initPorcupine()` using `PorcupineWorker.create(accessKey, keyword, onDetection, model)` async factory.
- [ ] Implement client state machine: `ASLEEP → WAKING → IDLE → LISTENING` with `Porcupine.pause()` / `Porcupine.resume()` transitions.
- [ ] Implement `playListeningChime()` via Web Audio API (880Hz → 1046Hz ascending two-note chime, per PRD_v2.md §A.5).
- [ ] Gate WebSocket construction behind wake word detection; WS must be `null` in `ASLEEP` state.
- [ ] Implement 30-second inactivity timer: on `turn_complete`, start timer; on expiry call `transitionToAsleep()`.
- [ ] Send `wake_word_detected` JSON message to server on detection (for logging; no server state change).
- [ ] Verify: Porcupine does not regress main audio pipeline; end-to-end latency unchanged on post-wake path.

## Phase 9: Native Google Search Grounding — v2.0
- [ ] Add `{ googleSearch: {} }` to the Gemini `tools` array alongside existing function declarations.
- [ ] Remove `search_browser` function tool definition from the Gemini tools array (superseded by native grounding).
- [ ] Implement `processGeminiStream()` to extract `candidate.groundingMetadata` from the final stream chunk.
- [ ] Wire grounding metadata to broadcast a `grounding_sources` WebSocket event to the client (sources display only — never TTS).
- [ ] Implement `sanitizeForTTS(text)` function to strip bare URLs, markdown links, citation brackets, and HTML tags before piping text to Piper.
- [ ] Apply `sanitizeForTTS` at the sentence-buffer ingestion point so it is enforced for all LLM output going forward.
- [ ] Update client to render `grounding_sources` messages as a visual attribution panel (not spoken).
- [ ] Verify: spoken TTS output contains no raw URLs or citation markers when grounding is active.

## Phase 10: Todoist Task Creation Tool — v2.0
- [ ] Add `TODOIST_API_TOKEN` to `.env` and `.env.example`; document where to get the token (Todoist developer settings).
- [ ] Register `add_todoist_task` function tool schema (per PRD_v2.md §C.1) in the Gemini `tools` array.
- [ ] Implement `executeTodoistTool()`: POST to `https://api.todoist.com/rest/v2/tasks` with Bearer auth, `X-Request-Id` UUID header, and `due_lang: 'en'` for NLP parsing.
- [ ] Set 4-second `AbortSignal.timeout` on the fetch call; handle 401, 429 (with `Retry-After`), and network timeout cases with distinct TTS error phrases.
- [ ] Inject tool result (`task_id`, `content`, `due.string`, `url`) back into Gemini `contents` as a `function` role part; verify model generates a clean spoken confirmation.
- [ ] Ensure `task.url` is NOT passed through `sanitizeForTTS` → it is dropped entirely, not read aloud.
- [ ] Write end-to-end test: speak "Remind me to call the dentist tomorrow at 9 AM" → verify Todoist task created with correct `due_string` and spoken confirmation plays.
