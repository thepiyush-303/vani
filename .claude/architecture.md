# Architecture — Vani Refinement Initiative

> How the three features are built, expressed against the **real** modules in this repo.
> Read alongside `decisions.md` (why) and `plan.md` (what/when).
> This is a design document. **No code is written until the user approves implementation.**

**Last updated:** 2026-09-03

---

## 0. Guiding invariants (do not break)

These properties hold today and MUST survive the refactor:

1. **Pure state machine.** `src/stateMachine.ts` `transition(state, event)` is a pure
   function returning `{ nextState, sideEffects }`. No I/O, no subprocess handles, no
   timers inside it. All effects run in `src/sideEffects.ts`.
2. **Single active session.** `src/session.ts` `SessionStore` is a singleton (single-user,
   local hardware). We are not adding multi-tenancy.
3. **Subprocess daemons persist across turns.** Whisper (`faster_whisper_server.py`) and
   Piper (`src/piperProcess.ts`) are long-lived; we send EOF/flush markers, we do not respawn
   per utterance.
4. **Binary WS framing is versioned by a header.** TTS audio frames use
   `[0xAF][0xFE][uint16 LE seq]` + PCM. Any new binary channel must not collide with this.
5. **Latency markers stay.** `SessionContext` timing fields (`speechEndAt`, `sttFinalAt`,
   `firstTokenAt`) and the `[latency]` logs are how we measure Feature 2. Keep them; extend them.

---

## 1. Current architecture (as-is baseline)

```
┌────────────────────────── Browser (public/) ──────────────────────────┐
│  index.html (single card UI)                                           │
│  client.js  ─ Silero VAD (vad/) ─ Porcupine wake word (porcupine/)     │
│             ─ mic capture 16kHz/512 ─ half-duplex micGated()           │
│             ─ playback AudioContext 22050Hz (TTS scheduler)            │
└───────────────┬─────────────────────────────▲─────────────────────────┘
                │ WS ws://localhost:8765       │ binary TTS + JSON events
                ▼                              │
┌──────────────────────────── Node server (src/) ───────────────────────┐
│  server.ts        WS + HTTP(3000) ; single-session guard               │
│  messageHandler.ts routes msgs → stateMachine → sideEffects            │
│  stateMachine.ts  PURE transition(state,event)→{nextState,sideEffects} │
│  sideEffects.ts   dispatcher: subprocess I/O, LLM, timers              │
│  session.ts       SessionStore singleton; seeds system prompt          │
│  sentenceBuffer.ts sentence chunking → Piper                           │
│  groqStream.ts    Groq (qwen) streaming + weather tool                 │
│  piperProcess.ts  Piper daemon; 4KB PCM WS frames                      │
│  types.ts         states, msgs, SideEffectName                         │
└───────┬───────────────────────────────┬───────────────────────────────┘
        │ stdin PCM / stdout JSON        │ stdin JSON / stdout raw PCM
        ▼                                ▼
 faster_whisper_server.py           Piper TTS (subprocess)
 (base.en int8 CPU, FAKE partials,  (en_US-lessac-medium, raw 22050Hz)
  real transcribe only at EOF)
```

Turn lifecycle today: `IDLE → LISTENING` (speech_start) → buffer PCM → `TRANSCRIBING`
(speech_end, EOF to Whisper) → `LLM_STREAMING` (final text → Groq) → `TTS_STREAMING`
(sentence buffer → Piper → client) → `turn_complete` → `IDLE`. Mic is gated the entire
time via `micGated()`.

---

## 2. Target architecture (all three features integrated)

```
┌──────────────────── Browser — React + Vite (new web/ app) ─────────────┐
│  <App> connection+turn state                                            │
│   ├─ <Orb>        canvas; amplitude from AnalyserNode (mic OR TTS)      │
│   ├─ <Captions>   live user text (Vosk) + live AI text (llm_token)      │
│   ├─ <Controls>   Connect/Disconnect · Mute/Unmute                      │
│   └─ <LogSidebar> slide-out; subscribes to event log                    │
│  hooks: useVadMic (Silero) · useWsClient · useAudioPlayback · useOrbLevel│
└───────────────┬───────────────────────────────▲───────────────────────┘
        16kHz PCM│ + speech_start/end            │ transcript_partial(vosk)
                 ▼                                │ transcript_final / llm_token
┌──────────────────────────── Node server (src/) ───────────────────────┐
│  server.ts · messageHandler.ts · stateMachine.ts (PURE) · sideEffects  │
│                                                                        │
│  NEW  sttHub.ts        fan mic frames → Vosk + Whisper; merge results  │
│  NEW  intentClassifier.ts  (pure) backchannel│stop│substantive         │
│  NEW  contextStore.ts  SQLite: turns + rolling summary (persistent)    │
│  NEW  summarizer.ts    off-hot-path LLM summary of old turns           │
│  session.ts  now hydrates history from contextStore on connect         │
└───┬──────────────┬───────────────────────────┬────────────────────────┘
    │ frames        │ frames + EOF              │ read/write turns
    ▼               ▼                           ▼
 vosk_server.py   faster_whisper_server.py   data/vani.db (SQLite)
 (streaming        (accurate FINAL only;      transcripts + summary
  partials)         real partials optional)   (NO audio on disk)
                          │
                          ▼  Piper daemon (unchanged) — killable mid-utterance for barge-in
```

The three features map onto this diagram as: **F1** = the entire browser column,
**F2** = `sttHub.ts` + `vosk_server.py` + real Whisper finalization, **F3** =
`intentClassifier.ts` + `contextStore.ts` + `summarizer.ts` + mic-live-during-TTS.

---

## 3. Feature 1 — Frontend rebuild (React + Vite + Canvas)

### 3.1 Where it lives
A new `web/` project (Vite + React + TypeScript). Dev: Vite dev server proxies nothing but
opens the WS directly to `ws://localhost:8765`. Prod: `vite build` → static assets served by
the existing Node HTTP server (currently port 3000). `public/vad/*` (Silero onnx/wasm) is
carried over as a static asset the client loads; `public/porcupine/*` is dropped (D4).

### 3.2 Component tree & responsibilities
- **`<App>`** — owns two orthogonal state axes:
  `connection ∈ {disconnected, connecting, connected}` and
  `turn ∈ {idle, listening, thinking, speaking}` (turn mirrors server `state_change`).
  Derives whether the mic may capture: `canCapture = connected && !muted`.
- **`<Orb>`** — a `<canvas>` painting a circular orb with **blue wavy patterns**. Amplitude
  comes from a single `level` value in `[0,1]`. Waves animate only when `level` exceeds a
  small floor; otherwise the orb rests in a calm idle state (subtle breathing, not flat).
  The wave source is whoever is speaking: mic input while `listening`, TTS output while
  `speaking`. Rendering runs on `requestAnimationFrame`; audio analysis is decoupled (see 3.3).
- **`<Captions>`** — two live regions beside the orb:
  - *User line*: updated from `transcript_partial` (Vosk interims) as the user speaks,
    then reconciled to `transcript_final` (Whisper).
  - *AI line*: appended word-by-word from `llm_token`, paced to feel concurrent with the
    audio the user hears (carry over the ~45ms/word pacing idea from today's client).
- **`<Controls>`** — Connect/Disconnect and Mute/Unmute. Unmute is disabled unless
  `connected`. Mute severs mic capture entirely ("no sound enters the app", D4/§F1 spec).
- **`<LogSidebar>`** — slide-out panel (toggle button) showing the event/log stream that the
  old UI printed to its log box. Subscribes to a client-side event log ring buffer.

### 3.3 Audio graph (browser)
```
getUserMedia({audio:{echoCancellation:true, noiseSuppression, autoGainControl}})
   │
   ├─► Silero VAD (useVadMic)  ─► speech_start / speech_end + 512-sample frames ─► WS
   │
   └─► AnalyserNode (mic)  ─┐
                            ├─► useOrbLevel → level[0..1] → <Orb>
   TTS playback graph ──────┘
   (22050Hz scheduler, AnalyserNode on the playback path)
```
Two `AnalyserNode`s (mic path and TTS-playback path); `useOrbLevel` selects the active one
based on `turn`. `echoCancellation:true` is requested here as the barge-in backstop (D7).

### 3.4 What is preserved vs replaced
- **Preserved logic** (ported into hooks): Silero VAD config, Float32→Int16 conversion,
  16kHz/512 framing, the 22050Hz playback scheduler + pre-buffer, `llm_token` word animation.
- **Replaced**: DOM-string UI, the single-card layout, the log `<div>`.
- **Removed**: Porcupine boot, ASLEEP/WAKING states, 30s inactivity auto-sleep, wake_word_detected.

### 3.5 Protocol impact
Frontend-only; no new server messages required for F1. `state_change` already carries the
turn state the UI needs. (Vosk `transcript_partial` semantics are defined in F2.)

---

## 4. Feature 2 — Live STT processing (hybrid, low perceived latency)

### 4.1 The core change
Introduce **`src/sttHub.ts`**: a module that receives the mic PCM frame stream for the
current utterance and **fans it out to two engines**:
- **Vosk** (`vosk_server.py`, new): a streaming recognizer fed frame-by-frame. Emits
  genuine interim hypotheses → server sends `transcript_partial` to the client for live
  captions, and forwards the same interims to the intent classifier (F3).
- **faster-whisper** (`faster_whisper_server.py`, existing): still receives the buffered
  audio and produces the **authoritative final** at `speech_end`. Its output remains the
  text appended to `conversationHistory` and sent to the LLM.

`sttHub` merges the two: partials come from Vosk during speech; the final comes from Whisper.
The state machine keeps its existing `whisper_final` internal event (now "stt_final" produced
by the hub) so `stateMachine.ts` transitions are unchanged in shape.

### 4.2 Removing the fake-partials hack
`faster_whisper_server.py` currently emits `{"type":"partial","text":"..."}` every 20 frames
as a placeholder — this is deleted. Whisper's job narrows to "final only." (Optionally it can
still be asked for a real partial via a windowed decode, but Vosk is the default partial
source, so this is not required.)

### 4.3 Accuracy on uncommon words (the user's complaint)
Two independent levers, both free/local:
- **Whisper vocabulary biasing**: pass an `initial_prompt` (and/or `hotwords`, depending on
  the faster-whisper version) containing the domain/uncommon terms so decoding is primed.
  Sourced from a small configurable term list. This directly targets the misread-words issue.
- **Vosk grammar/hotword biasing** where supported, for the live captions to look right too.
- `WHISPER_MODEL` remains an env dial (`base.en` default, `small.en` for more accuracy if CPU
  allows) — D9.

### 4.4 Latency framing
Perceived latency drops because captions appear *as the user speaks* (Vosk), and the LLM is
kicked off the instant Whisper finalizes — no change to the structural floor (D9). New latency
markers: `voskFirstPartialAt`, `voskFinalAt` added next to the existing `sttFinalAt` for
measurement.

### 4.5 CPU contention risk (must validate before committing)
Vosk + Whisper decoding concurrently on CPU. Vosk small model is light and streams cheaply;
Whisper only decodes once at EOF, so peak overlap is brief. Mitigation levers if needed:
smaller Whisper model, cap Whisper `num_workers`, or gate Whisper decode to start slightly
before EOF. Recorded as a risk in `plan.md`.

---

## 5. Feature 3 — Barge-in + persistent cross-session context

### 5.1 Two independent sub-systems
F3 is really (a) **interruption handling** and (b) **durable memory**. They compose but can
be built and tested separately.

### 5.2 Interruption / barge-in

**Mic stays live during `TTS_STREAMING`** (D7). Today `micGated()` blocks the whole turn and
`stateMachine.ts` treats `speech_start` during `TTS_STREAMING` as `NOOP` — both change.

**Pipeline when the user speaks over the assistant:**
```
user speaks over TTS
  → Silero VAD speech_start (mic no longer gated during speaking)
  → Vosk interim text streams into src/intentClassifier.ts
  → classifier decides:
       backchannel  → NOOP (assistant keeps talking)   ["yeah","mhm","right"...]
       stop/cancel  → HALT (ABORT_LLM_STREAM + KILL/flush Piper → LISTENING/IDLE)
       substantive  → BARGE_IN_CONFIRMED
  → on BARGE_IN_CONFIRMED: state machine goes TTS_STREAMING → BARGE_IN_INTERRUPTED
       side effects: ABORT_LLM_STREAM, flush/kill Piper, DISCARD partial AI turn,
       begin a fresh utterance capture whose final → new LLM turn (regeneration)
```

**Keeping the state machine pure.** The classifier is a *pure* module
(`intentClassifier.ts`: `(interimText, vadStats) → {kind}`). `messageHandler.ts` runs it and
feeds the state machine a **resolved** event (`barge_in_confirmed` / `stop_requested`), so
`stateMachine.ts` never does classification I/O. This mirrors how `whisper_final`/`stt_final`
is fed today. We also **unify** the `LLM_STREAMING` and `TTS_STREAMING` barge-in handling —
today `LLM_STREAMING + speech_start → BARGE_IN_INTERRUPTED` but `TTS_STREAMING` ignores it;
after F3 both route through the classifier so behavior is symmetric (noted in memory as the
asymmetry to fix).

**New/adjusted events & effects:**
- Client is allowed to send `speech_start/speech_end` during assistant speech (gating relaxed).
- Internal events: `barge_in_confirmed`, `stop_requested`, `backchannel_ignored`.
- Reuse existing `ABORT_LLM_STREAM`, `KILL_PIPER`; add a `FLUSH_TTS`/discard effect if a hard
  kill is too coarse. `tts_interrupted` is already a Server→Client message for the UI.

**Echo handling (D7).** Assume headphones; request browser `echoCancellation`. Guard against
self-echo with a short onset window after TTS starts + an energy threshold before the
classifier trusts a barge-in.

### 5.3 Persistent context (SQLite + rolling summary)

**`src/contextStore.ts`** wraps SQLite (proposed `better-sqlite3`; `node:sqlite` fallback).
DB file at a git-ignored `data/vani.db`. Minimal schema:
```
turns(   id INTEGER PK, ts INTEGER, role TEXT, content TEXT )   -- user/assistant/tool text
summary( id INTEGER PK CHECK(id=1), text TEXT, updated_ts INTEGER, covers_up_to_turn INTEGER )
meta(    key TEXT PK, value TEXT )                              -- schema version, etc.
```
**No audio is ever written** (D10). Only finalized transcript text + the rolling summary.

**Write path.** When a turn finalizes (user final appended; assistant turn completed),
`messageHandler.ts` calls `contextStore.appendTurn(...)`. This is off the latency-critical
path (after the response), so it does not affect TTFT.

**Read path (on connect).** `session.ts` `createSession` currently seeds only the system
prompt. It will additionally hydrate: `[system prompt] + [rolling summary] + [last K turns]`
into `conversationHistory`. This keeps prompt-prefill bounded (works with `groqStream.ts`'s
existing `capHistory()`/`MAX_HISTORY_MESSAGES`).

**Summarization (`src/summarizer.ts`).** When `turns` beyond the last K grow past a threshold,
run a background LLM call (Groq, D6) to fold older turns into `summary.text`, advancing
`covers_up_to_turn`. Runs between turns / on idle — never blocks a response. Prompt is
provider-agnostic but validated on Groq.

### 5.4 Data-flow summary (F3 memory)
```
connect ─► contextStore.load() ─► system + summary + last K turns ─► SessionStore.conversationHistory
turn done ─► contextStore.appendTurn(user), appendTurn(assistant)
idle/threshold ─► summarizer.fold(oldTurns) ─► contextStore.updateSummary()
```

---

## 6. Cross-cutting: message protocol delta (proposed, for later implementation)

| Direction | Message | Status | Notes |
|-----------|---------|--------|-------|
| S→C | `transcript_partial` | reused | now carries **real** Vosk interims |
| S→C | `transcript_final` | reused | Whisper authoritative final |
| S→C | `state_change` | reused | drives React turn state |
| S→C | `tts_interrupted` | reused | shown in UI on barge-in |
| C→S | `speech_start`/`speech_end` | semantics change | now permitted during TTS (barge-in) |
| C→S | `wake_word_detected` | **removed** | Porcupine dropped (D4) |
| internal | `barge_in_confirmed` / `stop_requested` / `backchannel_ignored` | **new** | produced by messageHandler after classifier |
| internal | `stt_final` | reused (renamed from whisper_final only if cheap) | produced by sttHub |

No change to the binary TTS frame header (`0xAF 0xFE seq`). If mic frames ever need a distinct
binary channel they will use a different, documented header — but current design keeps mic
frames on the existing path.

---

## 7. Forward-compatibility (no code now) ⏸

- **Tools (PD1).** `sttHub`/context changes are orthogonal to tool-calling; the existing
  `TOOL_EXECUTING` state and Groq/Gemini function-calling remain the seam. Persistent context
  will store `role:'tool'` turns too (schema already allows it).
- **Solari SDK (PD2).** Unknown surface; do not design against assumptions. The clean seam is
  a future `tools/solari.*` adapter invoked through the same tool path. Requires the user to
  provide SDK/API details before any design or code.
