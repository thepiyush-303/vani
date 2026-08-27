# Project Progress Tracker

## CURRENT STATUS
**Phase 5** — Phase 4 complete. Starting Phase 5: Tool Calling Contracts & Execution.

**Latency pass (2026-08-26):** application-level response-latency optimizations landed (no model change): Groq history capped to last 8 msgs to bound prefill/TTFT; sentence buffer flushes the first chunk on a shorter 60ms timeout for faster first-audio; Whisper `condition_on_previous_text=False`; real per-stage `[latency]` server logs (STT wall, Groq TTFT, perceived). Structural floor remains STT `base.en` (~850ms) + Groq free-tier TTFT (~1s) — strict <1000ms needs the `tiny.en` STT toggle (accuracy tradeoff) or a faster LLM. See `memory/vani_latency_budget.md`.

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
