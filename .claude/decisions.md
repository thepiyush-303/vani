# Decisions Log — Vani Refinement Initiative

> Architecture Decision Records (ADRs) for the three-feature refinement of Vani
> (frontend rebuild, live STT processing, barge-in + persistent context).
> Every entry records **what** was decided, **why**, and the **consequences** we accept.
> Later phases (tool integration, Solari SDK) are recorded as pending, not decided.

**Status key:** ✅ Accepted · 🟡 Provisional (revisit at implementation) · ⏸ Deferred (no code yet)

**Last updated:** 2026-09-05

---

## Context snapshot (why we are re-planning)

Vani is a working, single-user, half-duplex voice agent (Node/TS WebSocket server +
Python `faster_whisper_server.py` STT + Piper TTS + Groq/Gemini LLM + vanilla-JS
browser client with Silero VAD and a Porcupine wake word). Phases 1–4 of the original
PRD are complete. The refinement targets three weaknesses the user identified:

1. The frontend is a basic single card with Connect/Disconnect + a log box.
2. STT is **batch, not live** — the Python side emits placeholder `"..."` partials and only
   transcribes the whole utterance at `speech_end`; `base.en` + greedy decoding misreads
   uncommon words.
3. There is no real barge-in (mic is hard-gated for the whole assistant turn) and no
   persistent, cross-session memory (`conversationHistory` is in-RAM and lost on disconnect).

These decisions were confirmed with the user across two clarification rounds on 2026-09-03.

---

## D1 — STT stays free / local; no paid ASR ✅

**Decision.** Do not adopt any paid/cloud ASR (Deepgram, AssemblyAI, etc.). Use free,
locally-runnable engines and optimize them for latency.

**Why.** User constraint: "I can't use Paid Models for it so go ahead with free engines
which are available and optimize them to reduce latency." Also aligns with the project's
offline/privacy posture and zero running cost.

**Consequences.**
- We accept that raw accuracy will trail best-in-class cloud ASR; we compensate with
  vocabulary biasing and a two-engine design (see D2).
- CPU becomes the primary budget constraint, not API cost.
- Latency floor from the LLM (Groq TTFT) and Whisper decode remains structural
  (see D9) — STT streaming improves *perceived* latency, not the hard floor.

---

## D2 — Hybrid STT: Vosk (live partials) + faster-whisper (accurate final) ✅

**Decision.** Run two local engines in parallel per utterance:
- **Vosk** streaming recognizer → instant, frame-by-frame interim text → drives on-screen
  live captions (and feeds the barge-in intent classifier, see D8).
- **faster-whisper** → accurate final transcript at `speech_end` → this is what is appended
  to conversation history and sent to the LLM.

**Why.** The frontend needs *smooth live words as you speak* (Vosk excels: low-latency,
low-CPU streaming) while the LLM needs *accuracy on uncommon words* (Whisper excels).
A single engine cannot do both well. Both are free and local, satisfying D1.

**Alternatives rejected.**
- *faster-whisper only, streamed*: Whisper is not built for streaming; sliding-window
  partials flicker and re-decode expensively.
- *Vosk only*: too weak on uncommon words to feed the LLM.

**Consequences.**
- Two ASR processes run concurrently on CPU during speech → must verify combined load
  does not starve Whisper (see Risks in plan.md). Vosk small model (~40–50 MB) is light.
- The transcript the *user sees live* (Vosk) may differ slightly from the *final* (Whisper);
  the UI must reconcile gracefully (partial → replaced by final).
- New subprocess + frame fan-out wiring on the server (see architecture.md §F2).

---

## D3 — Frontend rebuilt on React + Vite + Canvas ✅

**Decision.** Replace the vanilla `public/index.html` + `public/client.js` with a small
React app built by Vite. The animated orb is rendered on a `<canvas>` (2D to start;
WebGL only if needed).

**Why.** The target UI is genuinely stateful (connection/turn states, live user captions,
live AI captions, mute, sidebar). React keeps that maintainable for production; Vite gives
a fast dev server + a simple static build. Canvas is the right tool for a 60fps
amplitude-reactive orb.

**Consequences.**
- Introduces a build toolchain the repo currently lacks (Vite, React deps). The existing
  Node HTTP server will serve the Vite build output in production and allow the WS in dev.
- Silero VAD stays (browser side); its `.onnx`/`.wasm` assets remain served as static files.
- We will follow the `frontend-design` skill's guidance for a distinctive, intentional
  visual direction rather than a templated default.

---

## D4 — Remove the Porcupine wake word; use explicit Connect + Mute ✅

**Decision.** Drop the "Hey Porcupine" wake-word flow and the ASLEEP/WAKING client states.
Boot to a Connect screen with the mic muted; the user clicks **Connect**, then **Unmute**
to talk. **Mute** stops all audio into the app; **Unmute** is disabled while disconnected.

**Why.** The user's described UX centers entirely on Connect/Disconnect + Mute/Unmute and
never mentions a wake word. Removing it simplifies the client state machine, drops the
Picovoice dependency and access-key handling, and makes behavior predictable.

**Consequences.**
- Delete Porcupine init/boot logic and the `PICOVOICE_ACCESS_KEY` requirement from the client.
- The 30s inactivity auto-sleep is removed (no ASLEEP state to return to); disconnect is manual.
- Porcupine static assets under `public/porcupine/` become dead; removal is optional cleanup.

---

## D5 — Persistent context via SQLite + rolling summary ✅

**Decision.** Persist every finalized turn to a local SQLite database. Feed the LLM a
**rolling summary of older turns + the last K recent turns** (not the full transcript).
Load summary + recent turns on connect so context survives disconnects and restarts.

**Why.** User wants "concrete stored context ... from the initial building of the
application ... not session-based." SQLite is durable, offline, dependency-light, and easy
to reason about. The rolling summary keeps LLM prompt-prefill (and thus Groq TTFT) bounded
even as history grows large — consistent with the existing 8-message send cap.

**Alternatives rejected.**
- *Vector DB / RAG*: most powerful recall but adds an embedding model + vector store +
  retrieval latency — over-engineered for a single-user assistant right now.
- *Flat JSON*: weakest at scale; must load everything into memory.

**Consequences.**
- New dependency for SQLite access (proposed `better-sqlite3`; `node:sqlite` is a fallback).
- Summarization consumes occasional extra LLM calls (off the hot path / between turns).
- **This reverses the original PRD's "no disk writes" privacy stance** — see D10.

---

## D6 — Groq stays the primary LLM; keep the provider toggle ✅

**Decision.** Target **Groq** (`qwen/qwen3.6-27b`, set via `GROQ_MODEL`) as the primary LLM
for context injection, barge-in regeneration, and later tool work. Keep the existing
`LLM_PROVIDER` env toggle so Gemini remains available.

**Why.** Groq's LPU gives the lowest time-to-first-token from the user's region, and the
model is already chosen and fixed by the user (free-tier constraint). Retaining the toggle
costs nothing and preserves Gemini's native Search Grounding for the future.

**Consequences.**
- New LLM-facing work (summary prompts, regeneration) is written provider-agnostically where
  cheap, but tuned/validated against Groq first.
- The qwen model is treated as **fixed** — do not swap it (see D9 for history).

---

## D7 — Barge-in assumes headphones; mic stays live during TTS ✅

**Decision.** Implement true barge-in by keeping the mic live during `TTS_STREAMING`.
Document that barge-in works best with **headphones** (no speaker→mic echo loop); rely on
the browser's `echoCancellation` as a backstop. No dedicated software AEC for now.

**Why.** Pragmatic and non-over-engineered. Real acoustic echo cancellation (routing TTS as
the AEC reference, or an AEC library) is significantly more complex and CPU-heavy; the
headphones assumption unblocks true barge-in immediately.

**Consequences.**
- On open speakers, self-echo may cause false barge-ins; mitigations: a short TTS-onset
  guard window + energy threshold + the intent classifier (D8).
- Software AEC is recorded as the future hardening path (see plan.md → Future).
- This relaxes the current full half-duplex gate (`micGated()` covering the whole turn).

---

## D8 — Barge-in intent via a lightweight local classifier ✅

**Decision.** A fast, local (non-LLM) classifier decides what an interruption means, using
the **Vosk interim transcript** (from D2) plus VAD duration/energy:
- **Backchannel** ("uh-huh", "yeah", "okay", "right", "mhm", short/low-energy) → **ignore**,
  keep speaking.
- **Stop/cancel** ("stop", "wait", "cancel", "hold on") → **halt** TTS + LLM, return to idle/listening.
- **Substantive utterance** → **barge-in**: abort the LLM stream + flush TTS, start a fresh
  turn with the new utterance, and regenerate the answer using retained context.

**Why.** The user explicitly asked for "intent classifiers" that "regenerate the content
based on the new sentence." A local classifier adds no network latency and naturally reuses
Vosk's instant interim text. It prevents backchannels from wrongly cutting off the assistant.

**Alternatives rejected.**
- *Every barge-in = new turn*: simplest, but backchannels like "mhm" would interrupt.
- *LLM-based intent*: most flexible but adds a round-trip on the latency-critical interrupt path.

**Consequences.**
- The classifier lives server-side (where Vosk interims are) as a pure, testable module; the
  state machine receives a resolved decision (e.g. `barge_in_confirmed`), staying pure.
- Keyword lists are English-first and configurable; false-negative/positive tuning is expected.

---

## D9 — Model & latency constraints treated as fixed inputs ✅

**Decision.** Carry forward known, non-negotiable constraints as design inputs:
- LLM is Groq `qwen/qwen3.6-27b`; **do not** suggest `llama-3.x` (decommissioned by Groq)
  or `gpt-oss-*` (spontaneous tool calls crash the stream).
- Perceived latency floor ≈ Whisper decode (~0.8–1s on `base.en` CPU) + Groq free-tier
  TTFT (~0.8–1.7s). Strict <1000ms end-to-end is **not** achievable app-side without the
  `tiny.en` accuracy tradeoff or a faster LLM.

**Why.** Established in prior sessions and project memory; avoids re-litigating settled ground
and prevents over-promising on latency.

**Consequences.**
- Feature 2's win is framed as **perceived** latency (instant Vosk captions + starting the LLM
  the moment Whisper finalizes), not beating the hard floor.
- `WHISPER_MODEL` remains an env toggle (`tiny.en`/`base.en`/`small.en`) — an accuracy/latency
  dial the user controls.

---

## D10 — Persisting transcripts reverses the PRD "no disk writes" rule ✅ (flagged)

**Decision.** Consciously accept that D5 writes conversation **transcripts and summaries** to
disk (SQLite), which contradicts the original PRD §1.3 "no disk writes" privacy requirement.
**Audio is still never persisted** — only text.

**Why.** The user directly requested durable cross-session memory. Persistent text is the
minimum needed; keeping raw audio out of storage preserves the strongest part of the privacy
posture.

**Consequences.**
- Document this reversal prominently so it is not mistaken for an oversight.
- Consider (later) a retention/clear-history control and on-disk location under a git-ignored
  `data/` path.

---

## D11 — Documentation & process conventions ✅

**Decision.** This initiative is tracked in `.claude/` via four documents: `plan.md` (master),
`architecture.md` (how), `decisions.md` (this file), `todo.md` (live progress). Planning only —
**no code** until the user approves implementation. Only files inside `.claude/` are created now.

**Why.** Explicit user instruction. Also honors CLAUDE.md: think before coding, simplicity
first, surgical changes.

**Consequences.**
- The existing root `PROGRESS.md` (original 10-phase plan) is **not** modified; where this
  initiative re-scopes old phases (e.g. old Phase 6 barge-in), the relationship is noted in
  plan.md. `PROGRESS.md` remains the historical/parallel tracker until the user says otherwise.

---

## D12 — Live STT is sequenced first, ahead of the frontend rebuild ✅

**Decision.** Execute **Feature 2 (Live STT) before Feature 1 (frontend rebuild)**, reversing
the initial "frontend first" ordering.

**Why.** User directive (2026-09-03). It is also technically clean: Live STT is server- and
Python-side and can be built/validated against the existing vanilla client (which already
renders `transcript_partial`/`transcript_final`), so it needs no new UI. The frontend rebuild
then lands on a working live-STT backend, so its live-caption behavior is real from day one
rather than stubbed.

**Consequences.**
- New execution order: Live STT → Frontend → (Persistent context ∥) → Barge-in. See plan.md §7.
- Barge-in's dependency on Vosk interims is satisfied early.
- Slightly more work validating Live STT on the old UI, which is then discarded — acceptable.

---

## D13 — No `sttHub.ts`; fan-out reuses the existing side-effect seams ✅

**Decision.** Drop the planned `src/sttHub.ts` coordinator. Vosk is driven by
`src/voskProcess.ts` (a wrapper mirroring `whisperProcess.ts`) plus three lines added to
existing seams: `feedLiveStt()` in `handleBinaryMessage`, and reset/finalize calls inside the
existing `OPEN_WHISPER_PIPE`, `SEND_EOF_TO_WHISPER`, and `DISCARD_WHISPER_BUFFER` side effects.

**Why.** The fan-out point already existed. `handleBinaryMessage` is the single place every PCM
frame passes through, and the whisper side effects already mark exactly the utterance boundaries
Vosk needs. A hub module would have been a pass-through wrapper around two subprocess modules —
an abstraction over one call site (CLAUDE.md: simplicity first, surgical changes).

**Consequences.**
- The pure state machine is untouched: no new states, no new transitions. Vosk events are
  display-only side channels that never transition state.
- `vosk_partial`/`vosk_final` both map to the existing `transcript_partial` client message, so
  the current UI shows live captions with no client change.
- Vosk needs a **silent reset** sentinel (`0xFFFFFFFF`) in addition to Whisper's finalize
  sentinel (`0x00000000`), because a new utterance or VAD misfire must clear recognizer state
  without emitting a caption. Whisper's protocol is otherwise unchanged.
- If live STT later needs genuine coordination (e.g. reconciling Vosk and Whisper text for
  barge-in intent in Phase 4), a hub can be introduced then, with a real reason.

---

## D14 — Vosk failure is non-fatal; live captions degrade silently ✅

**Decision.** If the Vosk model or package is missing, `voskProcess` disables itself after 3
immediate exits and logs remediation. The voice pipeline continues without live captions.

**Why.** Vosk is a UX enhancement, not a dependency of the core loop — Whisper still produces
the text the LLM sees. A missing 40MB model download must not prevent the app from starting, and
an unconditional respawn loop would spam logs and burn CPU on a machine already tight on it.

**Consequences.**
- `git clone` → `npm start` works before any Vosk model is downloaded.
- The failure is loud in logs but invisible to the user, so a silently-off caption feature is a
  plausible support question. Accepted: the log line names the cause and the fix.
- `models/` is git-ignored; the model path is configured via `VOSK_MODEL_PATH`.

---

## D15 — Frontend scaffold lives in `client/`, not `web/` ✅

**Decision.** The React/Vite app lives in `client/` at the repo root, not `web/` as `plan.md`
and `architecture.md` drafted. The Node HTTP server serves its production build from
`client/dist` (`PUBLIC_DIR`), with a `.svg` MIME type added and a startup warning when the
build is absent.

**Why.** The user scaffolded the Vite project into `client/` themselves ("I've build vite
directory in client folder") with `node_modules` already installed — my sandbox cannot run
`npm` against the network, so reusing their working scaffold was the only way to build offline,
and renaming it would have been churn for no benefit (CLAUDE.md: surgical changes).

**Consequences.**
- `plan.md`/`architecture.md` still say `web/` in prose; this ADR is the correction of record.
- `npm start` serves stale/empty UI until `cd client && npm run build` runs — documented in
  `server.ts`, `PROGRESS.md`, and `todo.md`.
- Dev uses Vite's own server (`cd client && npm run dev`) talking to the Node server over the
  WebSocket only; prod is the built static files. `client/public/vad/` is served at `/vad/` in
  both modes, so asset paths never change between dev and prod.

---

## D16 — MicVAD worklet + Silero weights remain CDN-fetched at load ✅ (flagged)

**Decision.** Keep `@ricky0123/vad-web`'s `baseAssetPath` pointed at jsdelivr
(`VAD_ASSET_PATH`), so `vad.worklet.bundle.min.js` and `silero_vad_legacy.onnx` are fetched from
the CDN when the mic opens. The onnxruntime `.wasm` runtime is already served locally from
`/vad/` (`onnxWASMBasePath` + `ortConfig`).

**Why.** The prototype's `modelURL: '/vad/silero_vad.onnx'` was never actually honored — MicVAD
has no per-file option and only reads `baseAssetPath`, so the prototype was *already* fetching
the worklet and a `_legacy` model from the CDN at runtime; the local `silero_vad.onnx` was dead
weight. I preserved the working behavior rather than silently repoint it to `/vad/` and risk a
VAD the user can't boot, which would be a debugging trap they didn't sign up for.

**Consequences.**
- Capture requires network at mic-open time. This is the one remaining runtime network
  dependency in an otherwise-local client.
- Documented fully-offline fix (in `useVadMic.ts` and `todo.md`): download those two files into
  `client/public/vad/` and set `VAD_ASSET_PATH = '/vad/'`. Deferred because it needs the user's
  network to fetch the files, which my sandbox lacks — a clean on-hardware follow-up.
- The vendored `client/public/vad/silero_vad.onnx` is currently unused by MicVAD; left in place
  (harmless, and the target of the offline fix).

---

## D17 — Orb mic amplitude comes from VAD frames, not a second AnalyserNode ✅

**Decision.** `useOrbLevel` takes the user-side loudness from the RMS of the same Float32
frames the VAD already processes (`useVadMic` computes it in `onFrameProcessed`), not from a
dedicated Web Audio `AnalyserNode` on the mic as `architecture.md` §3.3 drafted. The TTS side
still uses an `AnalyserNode` on the playback graph, since that audio never passes through the VAD.

**Why.** The VAD is already running an AudioContext over exactly the frames being sent to the
server; a second AnalyserNode would be a whole parallel context measuring the same signal. Using
the VAD frames removes that context entirely and guarantees the orb reflects precisely the audio
leaving the app — including going flat the instant Mute stops the tracks (CLAUDE.md: simplicity
first). `useOrbLevel` returns a sampling *function* the orb calls inside its own rAF, so per-frame
level changes never re-render React.

**Consequences.**
- One fewer AudioContext and no AnalyserNode teardown on the mic path.
- Mic and TTS levels are computed by two different code paths, so the same sqrt loudness curve is
  applied in both (`frameLevel` and the TTS branch) to keep the two speakers visually comparable.
- If a future feature needs frequency-domain mic data (not just amplitude), an AnalyserNode would
  have to be reintroduced then — no current need.

---

## Pending / not yet decided ⏸

- **PD1 — Tool integration.** Framework prepared but not designed here; the existing `tools/`
  dir + Groq/Gemini function-calling paths are the foundation. Decisions (which tools, timeout
  policy, validation) deferred to that phase.
- **PD2 — Solari SDK integration.** Specifics unknown; requires the user to provide Solari's
  SDK/API details when that phase begins. Recorded so the architecture stays forward-compatible;
  nothing fabricated.
