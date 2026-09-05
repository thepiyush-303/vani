# TODO — Vani Refinement Initiative (live tracker)

> The single source of truth for **what is being worked on right now**.
> Plan lives in `plan.md`; how in `architecture.md`; why in `decisions.md`.
> Update this file as phases start/land (CLAUDE.md: goal-driven execution).

**Last updated:** 2026-09-05 (Phase 2 frontend code-complete)

---

## ▶ Current pointer

**Phase 2 (Frontend rebuild) code is landed, builds clean, and lint/type-check/tests are green.
Awaiting on-hardware validation** (same box as Phase 1 — needs the Vosk model + a mic).

`npm start` now serves the Vite build from `client/dist`, so the client must be built first:
`cd client && npm run build`. In development, `cd client && npm run dev` serves the UI on Vite's
own port and talks to the Node server over the WebSocket.

Next: on hardware, walk the four observational acceptance criteria (orb waves on both voices,
live user captions, assistant caption/audio sync, Mute produces zero frames), then start
**Phase 3 (Persistent context)** or **Phase 4 (Barge-in)**.

---

## Legend
`[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked · `[-]` cancelled

---

## Milestone 0 — Planning (this phase)

- [x] Clarify STT / frontend / wake-word / memory decisions (round 1)
- [x] Clarify STT design / LLM / echo / intent decisions (round 2)
- [x] Write `.claude/decisions.md` (ADRs D1–D12 + pending)
- [x] Write `.claude/architecture.md` (as-is + target, per feature)
- [x] Write `.claude/plan.md` (master plan, acceptance criteria, phasing, risks)
- [x] Write `.claude/todo.md` (this file)
- [x] Verify docs are consistent with the codebase
- [x] Re-sequence to "Live STT first" per the user (D12)
- [x] **GATE:** user reviewed the plan and approved Phase 1 (Live STT) implementation

---

## Phase 1 — Feature 2: Live STT  `[~] code complete, pending on-hardware validation`  ◀ FIRST
_Depends on: nothing (validated on the current vanilla client). See `plan.md` §5, `architecture.md` §4._

- [x] Add `vosk_server.py` streaming recognizer (download model on user hardware)
- [x] `src/voskProcess.ts` — Node wrapper; fan-out lives in `handleBinaryMessage` +
      existing side effects rather than a new `sttHub.ts` (D13)
- [x] Remove fake `"..."` partials from `faster_whisper_server.py` (was at `len % 20 == 0`)
- [x] Emit real `transcript_partial` (Vosk) to the client — displays on the CURRENT UI's "You" box
- [x] Whisper vocabulary biasing (`initial_prompt`) + configurable term list (`vocab.txt`, `VANI_VOCAB`)
- [x] Add `voskFirstPartialAt` latency marker (`voskFinalAt` dropped — the Vosk final is
      display-only and lands before Whisper's, so it measures nothing actionable)
- [!] Validate CPU contention + final-latency budget (`plan.md` §7 R1/R2) — **user hardware**
- [!] Verify against acceptance criteria (`plan.md` §5.2) — **user hardware**

**Ships without a model:** if `VOSK_MODEL_PATH` is missing, `voskProcess` gives up after 3 fast
exits and logs how to fix it. Whisper → LLM → TTS is unaffected.

---

## Phase 2 — Feature 1: Frontend rebuild  `[~] code complete, pending on-hardware validation`
_Depends on: Phase 1 (live captions to display). See `plan.md` §4, `architecture.md` §3._

- [x] Scaffold the app (Vite + React 19 + TS). Landed in `client/` (the user scaffolded it there),
      **not** `web/` as the plan drafted — see D15. Wired the Node HTTP server to serve `client/dist`.
- [x] `useWsClient` hook — connect/disconnect, session_init handshake, JSON + binary frame demux
- [x] `useVadMic` hook — ported Silero VAD config + 16kHz/512 framing + Float32→Int16; owns the
      MediaStream so Mute stops the tracks outright
- [x] `useAudioPlayback` hook — ported 22050Hz scheduler + pre-buffer + barge-in flush; `speaking`
      driven by the playback clock, not server state
- [x] `useOrbLevel` hook — one amplitude source, selected by turn state. Mic level comes from the
      VAD's own frames (not a second AnalyserNode — see D17); TTS level from a playback AnalyserNode
- [x] `<Orb>` — canvas polar oscilloscope; three traces wave on real amplitude, calm when idle
- [x] `<Captions>` — live user line (Vosk partials from Phase 1) + word-by-word AI reveal (~45ms/word)
- [x] `<Controls>` — Connect/Disconnect, Mute/Unmute (Unmute disabled while disconnected)
- [x] `<LogSidebar>` — slide-out log panel + toggle (Escape to close)
- [x] Remove Porcupine from the client entirely (D4) — grep-verified across `src/`, `index.html`, `dist/`
- [x] Green build: `client` `npm run build` + `npx eslint .` clean; root `npx tsc --noEmit` clean;
      root `npm test` 3 suites / 57 tests pass
- [!] Verify the four observational criteria (`plan.md` §4.2: orb waves both voices, live user
      captions, AI caption/audio sync, Mute = zero frames) — **user hardware**

**Runtime note:** MicVAD still fetches `vad.worklet.bundle.min.js` + `silero_vad_legacy.onnx` from
jsdelivr at load (the `.wasm` runtime is already served locally from `/vad/`). For fully-offline
capture, drop those two files into `client/public/vad/` and set `VAD_ASSET_PATH = '/vad/'` in
`useVadMic.ts`. Behavior is otherwise unchanged. See D16.

---

## Phase 3 — Feature 3a: Persistent context  `[ ] not started`  (parallelizable)
_Depends on: nothing structural; can overlap any phase. See `plan.md` §6.3, `architecture.md` §5.3._

- [ ] Add SQLite dep (`better-sqlite3`; `node:sqlite` fallback); git-ignore `data/`
- [ ] `src/contextStore.ts` — schema (turns, summary, meta); append/load; **no audio**
- [ ] `src/summarizer.ts` — off-hot-path rolling summary (Groq)
- [ ] `session.ts` — hydrate `system + summary + last K turns` on connect
- [ ] Verify cross-restart recall + bounded prompt-prefill (`plan.md` §6.3)

---

## Phase 4 — Feature 3b: Barge-in  `[ ] not started`
_Depends on: Phase 1 (Vosk interims). See `plan.md` §6.2, `architecture.md` §5.2._

- [ ] Relax `micGated()` so mic stays live during `TTS_STREAMING`
- [ ] `src/intentClassifier.ts` (pure) — backchannel | stop | substantive
- [ ] Feed resolved `barge_in_confirmed` / `stop_requested` events to the pure state machine
- [ ] Unify `LLM_STREAMING` + `TTS_STREAMING` barge-in handling
- [ ] Regeneration path: abort LLM + flush TTS + new turn from the interrupting utterance
- [ ] Self-echo mitigation: onset guard + energy threshold (headphones assumption, D7)
- [ ] Verify against acceptance criteria (`plan.md` §6.2)

---

## Deferred (prepare only — no code) ⏸
- [ ] PD1 — Tool integration plan (when greenlit)
- [ ] PD2 — Solari SDK integration — **blocked on the user providing SDK/API details**

---

## Open questions for the user (from `plan.md` §9 / decisions)
- [ ] Provide the uncommon-word/term list for STT biasing — add to `vocab.txt` (seeded with
      placeholders) or `VANI_VOCAB`. Phase 1 shipped with the mechanism, not the terms.
- [ ] Confirm `better-sqlite3` vs `node:sqlite` preference for the context store (Phase 3).
- [ ] Confirm `K` (recent turns kept verbatim) and the summary trigger threshold — or accept
      sensible defaults to be proposed at Phase 3.
- [ ] Solari SDK/API details (blocks PD2).

---

## Notes / blockers
- Sandbox bash has **no outbound network** (proxy 403): model downloads (Vosk/Whisper) and
  live Groq/API tests must be run on the user's hardware — flag such steps here as `[!]` when
  reached (`plan.md` §9 R8).
