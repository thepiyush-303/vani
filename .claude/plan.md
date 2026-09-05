# Plan — Vani Refinement Initiative (Master Plan)

> The master plan for making Vani "concrete and stable" for production, in three features.
> Companion docs: **`architecture.md`** (how it's built) · **`decisions.md`** (why, ADRs) ·
> **`todo.md`** (live progress pointer).
>
> ⚠️ **Planning phase only. No code is written until the user explicitly approves
> implementation of a feature.** This document is the thing to approve.

**Owner:** user (senior AI systems engineer) · **Status:** awaiting approval to implement
Feature 1 · **Last updated:** 2026-09-03

---

## 1. Purpose & scope

Vani works end-to-end but is a prototype: a single-card UI, batch (not live) STT that
misreads uncommon words, no real barge-in, and memory that dies with the session. This
initiative hardens three areas into production-quality behavior:

1. **Feature 1 — Frontend rebuild:** a focused, single-screen voice UI built on
   React + Vite + Canvas, centered on an animated blue orb that reacts to whoever is
   speaking, with live captions, explicit Connect/Mute controls, and a slide-out log sidebar.
2. **Feature 2 — Live STT processing:** stream speech to a live recognizer so words appear
   as they are spoken, while a second engine produces an accurate final for the LLM — free,
   local engines only, tuned for low *perceived* latency and better uncommon-word accuracy.
3. **Feature 3 — Barge-in + persistent context:** let the user interrupt the assistant
   mid-answer with intent-aware handling, backed by durable, cross-session memory in SQLite.

**Out of scope for this initiative (prepare only, no code — see §8):** deep tool integration
and the Solari SDK. We keep the architecture forward-compatible with them and nothing more.

---

## 2. Principles (from CLAUDE.md, applied here)

- **Think before coding.** This plan + its clarifying Q&A exist so we do not silently pick an
  interpretation. Open questions are listed in §9.
- **Simplicity first.** Minimum code to meet each acceptance criterion. No speculative
  features, no abstractions for single-use code (e.g. no vector DB, no software AEC yet).
- **Surgical changes.** Reuse the pure state machine, the singleton session, the persistent
  subprocess daemons, and the existing latency instrumentation. Touch only what each feature
  needs.
- **Goal-driven.** `todo.md` tracks the active feature/phase; we update it as phases land.
  (`PROGRESS.md` at the repo root is left untouched — see §10.)

---

## 3. Current state (baseline we build on)

- **Frontend:** `public/index.html` + `public/client.js` — one dark card: status dot,
  Porcupine wake badge, VAD meter, You/Assistant boxes, grounding panel, Connect/Disconnect,
  a 110px log box. Silero VAD in-browser; 22050Hz TTS playback scheduler; full half-duplex
  `micGated()`.
- **STT:** `faster_whisper_server.py` (base.en, int8, CPU, greedy). **Partials are fake**
  (`"..."` placeholder every 20 frames); real transcription only at `speech_end`.
- **LLM:** `src/groqStream.ts` streaming Groq `qwen/qwen3.6-27b` (+ Gemini behind
  `LLM_PROVIDER`). History capped to 8 messages.
- **TTS:** `src/piperProcess.ts` Piper daemon → 4KB PCM WS frames.
- **Core:** pure `src/stateMachine.ts`; `src/sideEffects.ts` dispatcher; singleton
  `src/session.ts` (in-RAM history, lost on disconnect); `src/messageHandler.ts` routing.
- **Known fixed constraints (D9):** qwen model fixed; avoid llama-3.x / gpt-oss; perceived
  latency floor ≈ Whisper decode + Groq TTFT; strict <1s not reachable app-side.

Full as-is and to-be diagrams live in `architecture.md` §1–§2.

---

## 4. Feature 1 — Frontend rebuild

### 4.1 Behavior spec (from the user)
- Full plain screen; a **centered circular orb** rendering **blue wavy patterns**.
- Orb **waves only when someone is speaking** (user *or* AI); otherwise it stays calm/still.
- **Live text beside the orb:** the user's words appear live as they speak; the AI's words
  appear live, word-by-word, **concurrent with the audio** the user hears.
- **Mute/Unmute** button below (mute = no sound enters the app).
- **Connect/Disconnect**; the user can only unmute/talk while connected.
- **Logs move into a slide-out sidebar** toggled by a button.
- Wake word removed (D4).

### 4.2 Acceptance criteria
- [ ] App builds with Vite and serves via the existing Node HTTP server in production.
- [ ] On load: disconnected, mic muted, Unmute disabled. Connect enables the session; Unmute
      enables capture.
- [ ] Orb visibly waves in blue when the user speaks and when the AI speaks, and is calm when
      neither is speaking — driven by real audio amplitude, not a fixed timer.
- [ ] User captions update live while speaking, consuming the Vosk interims delivered by
      Feature 2 (which now **precedes** this phase — see §7 / D12).
- [ ] AI captions stream word-by-word roughly in sync with TTS audio.
- [ ] Mute immediately stops all mic audio entering the app (verifiable: no frames sent, orb
      calm, VAD silent).
- [ ] Log sidebar slides in/out via its toggle and shows the events the old log box showed.
- [ ] No Porcupine code path remains in the client.

### 4.3 Notes
Silero VAD, PCM framing, and the TTS playback scheduler are **ported, not reinvented**
(`architecture.md` §3.4). Visual direction follows the `frontend-design` skill. The orb's
amplitude source switches between mic and TTS-playback analysers based on turn state.

---

## 5. Feature 2 — Live STT processing

### 5.1 Behavior spec
Words stream to the recognizer and become text **live**, without waiting for the full
utterance, to cut perceived latency; a second engine still yields an accurate final for the
LLM; uncommon-word accuracy improves. Free/local engines only (D1, D2).

### 5.2 Acceptance criteria
- [ ] `src/sttHub.ts` fans mic frames to Vosk (streaming) and faster-whisper (final).
- [ ] Real `transcript_partial` messages stream from Vosk during speech (the `"..."`
      placeholder in `faster_whisper_server.py` is gone).
- [ ] `transcript_final` (Whisper) is what is appended to history and sent to the LLM.
- [ ] A configurable term list biases Whisper (`initial_prompt`/`hotwords`) and demonstrably
      fixes at least the user's example misreads.
- [ ] New latency markers (`voskFirstPartialAt`, `voskFinalAt`) logged next to `sttFinalAt`.
- [ ] Measured: first on-screen word appears well before `speech_end` (proves "live").
- [ ] CPU check: Vosk+Whisper concurrency does not regress final-transcript latency beyond an
      agreed budget (see §7 R2).

### 5.3 Notes
The state machine's final-transcript event keeps its current shape (hub emits it); only the
*source* of partials changes. `WHISPER_MODEL` stays an accuracy/latency dial (D9).

---

## 6. Feature 3 — Barge-in + persistent context

### 6.1 Behavior spec
While the AI is talking, the user can interrupt. The system classifies intent and, for a
substantive interruption, regenerates the answer from the new utterance. Backchannels
("mhm", "yeah") do not stop the assistant; "stop/cancel" halts it. Requires durable,
cross-session context covering the whole history of the app's use (not per-session).

### 6.2 Acceptance criteria — interruption
- [ ] Mic stays live during `TTS_STREAMING`; `micGated()` no longer blocks the whole turn.
- [ ] `src/intentClassifier.ts` (pure) maps Vosk interim + VAD stats →
      `backchannel | stop | substantive`.
- [ ] Backchannel → assistant keeps speaking. Stop → TTS+LLM halt promptly. Substantive →
      LLM aborts, TTS flushes, a new turn regenerates using retained context.
- [ ] `LLM_STREAMING` and `TTS_STREAMING` barge-in handling is unified/symmetric.
- [ ] `stateMachine.ts` stays pure — it receives resolved `barge_in_confirmed` /
      `stop_requested` events, not raw audio.
- [ ] With headphones, talking over the assistant reliably barges in; self-echo on speakers is
      mitigated (onset guard + energy threshold) and does not constantly false-trigger.

### 6.3 Acceptance criteria — persistent context
- [ ] `src/contextStore.ts` persists finalized turns to `data/vani.db` (SQLite). **No audio.**
- [ ] On connect, `session.ts` hydrates `system prompt + rolling summary + last K turns`.
- [ ] `src/summarizer.ts` folds old turns into a rolling summary off the hot path (no TTFT
      impact).
- [ ] Restarting the server and reconnecting preserves relevant context (verifiable: reference
      something from a prior session and the assistant recalls it).
- [ ] Prompt-prefill stays bounded as history grows (works with `groqStream.ts` `capHistory()`).

### 6.4 Notes
Echo strategy is headphones-assumption + browser `echoCancellation` (D7); software AEC is
future work. Intent keyword lists are configurable (D8).

---

## 7. Phasing, sequencing & dependencies

Execution order (**updated 2026-09-03 per the user: Live STT first** — see D12). Each phase is
independently shippable and testable:

```
Phase 1 — Feature 2: Live STT           (depends on: nothing; validated on the CURRENT vanilla client)
   └─ Vosk hub + real partials + Whisper finalization + vocab biasing
Phase 2 — Feature 1: Frontend rebuild   (depends on: Phase 1 for live captions to display)
   └─ React/Vite/Canvas UI; wires Vosk partials into <Captions>, TTS into the orb
Phase 3 — Feature 3a: Persistent context (depends on: nothing structural; parallelizable)
   └─ SQLite contextStore + summarizer + connect-time hydration
Phase 4 — Feature 3b: Barge-in          (depends on: Phase 1 for Vosk interims → classifier)
   └─ mic live during TTS + intentClassifier + unified barge-in
```

Rationale: the user prioritized Live STT first. It is buildable and testable against the
**existing** vanilla client (which already renders `transcript_partial`/`transcript_final`), so
it needs no frontend work to validate. The frontend rebuild then consumes a *working* live-STT
backend, so its live-caption criterion is met immediately rather than stubbed. Barge-in still
depends on Vosk interims (now delivered in Phase 1). Persistent context has no hard dependency
and can proceed in parallel with any phase.

**Dependency callouts:** Phase 4 needs Phase 1 (Vosk). Phase 3 independent. Phase 1 independent
(uses the current UI to validate). Phase 2 consumes Phase 1's partials.


---

## 8. Forward-looking — tools & Solari (PREPARE ONLY, no code) ⏸

- **Tool integration (PD1).** The existing `TOOL_EXECUTING` state, `tool_call`/`tool_result`
  messages, and Groq/Gemini function-calling are the foundation. Persistent context will store
  `role:'tool'` turns. We take no design decisions here beyond keeping these seams intact. A
  dedicated plan will follow when the user greenlights it.
- **Solari SDK (PD2).** Not in the codebase or general knowledge; **nothing will be fabricated.**
  The clean integration seam is a future `tools/solari.*` adapter behind the existing tool path.
  **Needed from the user before any design/code:** Solari's SDK/API surface, auth model, and
  the capabilities Vani should expose through it.

---

## 9. Risks & mitigations

| # | Risk | Impact | Mitigation |
|---|------|--------|-----------|
| R1 | CPU contention: Vosk + Whisper concurrent decode | slower finals, audio glitches | Vosk small model; Whisper decodes once at EOF; smaller `WHISPER_MODEL`; cap `num_workers` (F2 §5.3) |
| R2 | Final-transcript latency regresses vs today | worse UX despite "live" captions | measure `sttFinalAt` before/after; agree a budget; roll back hub fan-out if over |
| R3 | Self-echo false barge-ins on open speakers | assistant cuts itself off | headphones assumption (D7) + onset guard + energy threshold + classifier |
| R4 | Persisted transcripts reverse PRD "no disk writes" | privacy-posture change | conscious, documented (D10); audio never stored; future clear-history control |
| R5 | Rolling summary drops needed detail | assistant "forgets" specifics | keep last K turns verbatim; tune K + summary threshold; store full turns in SQLite for recovery |
| R6 | State-machine purity eroded by barge-in complexity | hard-to-test regressions | classifier is a pure module; machine only sees resolved events (D8, arch §5.2) |
| R7 | New Vite build toolchain adds friction | slower dev, deploy confusion | keep Node HTTP server serving the build; document dev vs prod (arch §3.1) |
| R8 | Sandbox has no outbound network | can't test Groq/Vosk downloads here | validated on user hardware; note in `todo.md` when a step needs the user to run it |

---

## 10. Relationship to existing `PROGRESS.md`

The root `PROGRESS.md` describes the original 10-phase build (Phases 1–4 done; 5 tools in
progress; 6 barge-in, 7 hardening, 8 wake word, 9 grounding, 10 Todoist pending). This
initiative **re-scopes** some of it: old Phase 6 (barge-in/prefetch) is now Feature 3;
old Phase 8 (Porcupine wake word) is **cancelled** (D4). Per the user's instruction to only
add files under `.claude/`, `PROGRESS.md` is **not edited** in the planning phase. If/when the
user wants a single source of truth, we will reconcile them.

---

## 11. Definition of done (initiative-level)

All three features meet their acceptance criteria (§4.2, §5.2, §6.2/§6.3); latency is measured
and within agreed budgets; the state machine remains pure and unit-testable; no dead Porcupine
code; docs in `.claude/` updated; and the app is demonstrably stable across
connect/disconnect/restart with context preserved.
