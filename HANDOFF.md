# Vani — Engineering Handoff

**Date:** 2026-09-05
**Purpose:** Full context + progress so another AI/engineer can continue without prior conversation.
**Repo root:** `/…/vani` (this file lives at repo root).

---

## 0. How to use this document

Read sections **1 → 3** for context and hard rules, **4 → 5** for exactly what state the code is in
right now, and **6** for the step-by-step plan to finish. Section 6 is ordered — do it top to bottom.
Nothing here requires the earlier chat transcript, but its path is in §10 if you want the raw log.

The repo has its own planning docs that remain authoritative for the *why*:
`.claude/plan.md` (master plan), `.claude/architecture.md` (as-is/target design), `.claude/decisions.md`
(ADRs D1–D17), `.claude/todo.md` (live tracker), `PRD.md` / `PRD_v2.md` (product spec),
`PROGRESS.md` (phase tracker). **Read `PRD.md` + `PROGRESS.md` before writing code** (CLAUDE.md rule).

---

## 1. What Vani is

A **local-first, low-latency voice AI agent**. Pipeline:

```
browser mic
  → Silero VAD (@ricky0123/vad-web, client)
  → 16 kHz / 512-sample Int16 PCM over WebSocket (ws://host:8765)
  → STT:  Vosk (live streaming captions)  +  faster-whisper (final text → LLM)
  → LLM:  Groq (default) or Gemini, streamed token-by-token
  → sentence-buffered → Piper TTS subprocess → raw PCM
  → binary WS frames (22050 Hz) → Web Audio scheduler in the browser
```

**Server** (`src/`, Node + TypeScript): a pure state machine (`stateMachine.ts`) driving a named
side-effect dispatcher (`sideEffects.ts`), a singleton session (`session.ts`, in-RAM
`conversationHistory`), and `messageHandler.ts` routing WS + internal subprocess events. STT/TTS/LLM
are subprocesses/streams that fire internal events via `emitInternalEvent → handleInternalEvent`.

**Client** (`client/`, Vite 8 + React 19 + TypeScript): a single-screen "instrument panel, not a chat
window." A centered canvas **orb** (polar oscilloscope) waves from real mic/TTS amplitude; the user's
words stream on the left, the assistant's on the right; Connect/Mute controls; a slide-out Log panel.

**Design language** (keep it consistent): three typefaces — `--face-label` (condensed),
`--face-mono`, `--face-serif`. Tokens in `client/src/index.css`: `--ink #070b14`, `--ink-2 #0d1424`,
`--signal #4fa8ff`, `--signal-deep #6b7bff`, `--paper #e8eef7`, `--muted #6e819e`, `--amber #f5b544`,
`--rule #1b2740`. User caption = mono, right-aligned; assistant caption = serif; assistant label = amber.

Current program state: v1 Phases 1–4 done; v2 tool/grounding phases (5,8–10) partially specced; a
**Refinement Initiative (v2.1)** is underway — R-Phase 1 (Live STT) landed, R-Phase 2 (frontend rebuild)
code-complete. This handoff sits inside a batch of four UI fixes that precede R-Phase 3 & 4.

---

## 2. The current task (verbatim)

The user asked for four fixes, then to proceed to the next phases. Exact wording:

> 1. My text looks like this … I can't see the spaces between it. solve this minor fix.
> 2. Also The text generated from AI is not Live it just transitions the whole sentence, solve it if
>    possible if not then fallback to lowering speed of delivering the ai-text to which piper is
>    generating the speech.
> 3. Also I want to see the previously generated text by scrolling them for both side. There should be
>    proper gap between the responses and the previous responses should get little faded from the top
>    and newly generated text should be shown in between like exactly as the current behavior and I can
>    scroll through them as I want to see any previous message (upto 5 message for both side), and when
>    new text is being generated from either side it be scroll back to middle of the screen.
> 4. Also maintain the history of the conversations from both side like I can see them in a sidebar,
>    create that interface similar to what chatbots follows and it should be storing it in db and should
>    be persistent throughout the sessions.
> After making the above verification and implementation the above requests then Move forward with next
> phase (persistent context) and barge-in.

**Clarifications the user gave (binding):**

- **History organization (#4):** *"One running transcript — just add a line between session to session
  transcript. Just to split the conversations."* → The sidebar is **one continuous chronological
  transcript** with a visual divider between sessions. **NOT** a ChatGPT-style list of separate
  conversations.
- **SQLite engine:** **`better-sqlite3`** (not `node:sqlite`).

---

## 3. Non-negotiable constraints (READ FIRST)

From `CLAUDE.md` and the project's saved memory. Violating these has burned time before.

**Working style (CLAUDE.md):**
1. **Think before coding** — if a request is ambiguous, ask; don't silently pick one reading.
2. **Simplicity first** — minimum code; no speculative features or single-use abstractions.
3. **Surgical changes** — touch only what's needed; no unrelated refactors or reformatting.
4. **Goal-driven** — update `PROGRESS.md` when a phase completes; read `PRD.md` + `PROGRESS.md` first.

**Product/infra facts:**
- **Never persist audio.** Only text is stored (ADR D10). The SQLite store holds transcript text only.
- **No paid ASR/LLM models.** STT is local (Vosk + faster-whisper); LLM is Groq free tier / Gemini.
- **`GROQ_MODEL=qwen/qwen3.6-27b` is fixed** (user-set). Do **not** switch to `gpt-oss` (spontaneous
  tool calls) or `llama-3.x` (decommissioned by Groq).
- **Half-duplex today (D7).** The client gates the mic across the whole assistant turn (self-echo +
  room noise). Real barge-in is R-Phase 4. Gating is driven by the **playback clock** (`speaking`),
  not server state.
- **Latency floor** ≈ STT `base.en` (~850 ms) + Groq TTFT (~1 s) + synth. Sub-1000 ms perceived is not
  reachable app-side without the `tiny.en` STT toggle (accuracy trade-off). Don't chase it in code.

**Environment gotchas (this AI sandbox — may not apply to the user's own machine):**
- **Sandbox bash has no outbound network** (proxy 403). Cannot `npm install` native modules
  (e.g. `better-sqlite3`), download Vosk/Whisper models, or hit Groq/Gemini/Todoist. Those steps run on
  the **user's hardware**. This is why `contextStore.ts` uses a graceful-disable pattern (see §5).
- **The `Write` tool is blocked on the project `.claude/` directory.** To edit files there, write to a
  scratch/outputs dir and `cp` via bash; deletes need an explicit allow step. (Editing `src/`,
  `client/`, and repo-root docs like this one works normally.)
- Content blocked by web fetch/search must not be retrieved by other means.

**Client TypeScript / lint rules that will bite you** (`client/tsconfig.app.json`, eslint):
- `erasableSyntaxOnly` + `verbatimModuleSyntax`: **no `enum`s** — use string-literal unions. Use
  `import type { … }` for type-only imports. Import paths include the `.ts`/`.tsx` extension
  (`allowImportingTsExtensions`, `moduleResolution: bundler`).
- `noUnusedLocals` / `noUnusedParameters`: no dead bindings.
- `eslint-plugin-react-hooks@7` (React-Compiler-aware): **no ref writes during render** (do them in
  `useEffect` or event handlers); **no synchronous `setState` inside an effect**. To reset child state,
  remount via a `key` prop (this is exactly how `AssistantCaption` resets per reply — see §5).
- **Server has no ESLint** (only the client does). Root `tsconfig.json` is `strict: true`, CommonJS,
  ES2022. Dynamic `require()` returns `any` and tsc does **not** verify the module exists → this is what
  makes the graceful-disable pattern compile without the native dep installed.

---

## 4. Progress snapshot

| # | Item | Status |
|---|------|--------|
| Fix #1 | Spaces between user caption words | **DONE** (client) |
| Fix #2 | Live/synced assistant caption reveal | **~60%** — playback plumbing done; `AssistantCaption` + `App` wiring pending |
| Fix #3 | Scrollable last-5-per-side stage with top fade | **Not started** |
| Fix #4 | Persistent history sidebar (SQLite) | **Server DONE + verified**; client: protocol type added, rest pending |
| R-Phase 3 | Persistent cross-session context | Not started (comes after the 4 fixes) |
| R-Phase 4 | Barge-in | Not started (comes after R-Phase 3) |

**Verification status of what's done:** server `npx tsc --noEmit` = exit 0; root `npm test`
(`jest --runInBand --forceExit`) = **57/57 pass**, exit 0. Client build not re-run since the client
edits so far are minimal and type-clean; **re-run the full green gate (see §7) after finishing #2–#4.**

---

## 5. Exact changes already made

### Fix #1 — DONE

**`client/src/index.css`** — `.caption__word` now sets an explicit gap because `display:inline-block`
collapses whitespace between spans (the `word-in` animation uses `translate`, which needs inline-block):

```css
.caption__word {
  display: inline-block;
  /* inline-block collapses the whitespace between words, so the gap is set
     explicitly here rather than with a space character in the markup. */
  margin-inline-end: 0.28em;
  animation: word-in 180ms ease-out both;
}
```

**`client/src/components/Captions.tsx`** — `UserCaption` word span no longer emits a trailing `{' '}`
(the CSS margin replaces it). Current `UserCaption` splits on `/\s+/`, filters empties, maps to
`<span className="caption__word" key={`${i}:${word}`}>{word}</span>`.

### Fix #2 — plumbing DONE, reveal logic PENDING

**`client/src/hooks/useAudioPlayback.ts`** — added an exported `remainingMs()` callback and return it.
It reports how much scheduled audio is still ahead of the Web Audio clock (ms). This is the signal the
caption reveal will pace against. Current code:

```ts
/** Buffered audio still ahead of the playback clock, in ms — how much sound
 *  is scheduled but not yet heard. The caption reveal paces itself to this so
 *  the words track Piper's voice instead of racing the LLM's token burst. */
const remainingMs = useCallback(() => {
  const ctx = ctxRef.current;
  if (!ctx) return 0;
  return Math.max(0, (nextStartRef.current - ctx.currentTime) * 1000);
}, []);
// …
return { enqueue, flush, remainingMs, speaking, analyserRef };
```

(The `enqueue` tail timer uses a local `tailMs = remaining + ECHO_TAIL_MS`, `ECHO_TAIL_MS = 300`.)

**Still to do for #2:** `AssistantCaption` does not yet consume audio timing — it still reveals at a
fixed `WORD_MS = 45` (~1333 wpm), which is the bug (text dumps ~instantly, way ahead of Piper's
~150 wpm voice). And `App.tsx` does not yet track "has audio started this reply" nor pass `remainingMs`
down. See §6.1 for the exact edit.

### Fix #4 — SERVER DONE & VERIFIED; client type added

**`src/contextStore.ts`** (NEW) — durable SQLite transcript with a **graceful-disable** pattern:
`require('better-sqlite3')` inside `try/catch` with hand-written structural types (`SqliteDb`,
`PreparedStatement`, `SqliteCtor`); if the native module is absent, every function becomes a safe no-op
and the app runs unchanged (mirrors the Vosk approach, D14). Exports:
- `PersistedTurn { role: 'user'|'assistant'; content: string; session_id: string; ts: number }`
- `initContextStore(dbPath = process.env.VANI_DB_PATH ?? 'data/vani.db')`
- `isContextStoreEnabled(): boolean`
- `appendTurn(sessionId, role, content)` — trims, no-op if disabled, never throws
- `loadRecentTurns(limit = 400)` — returns chronological **oldest-first** (`HISTORY_LOAD_LIMIT = 400`)

Schema: `turns(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, ts INTEGER)`,
`journal_mode = WAL`. Only `user`/`assistant` roles are persisted.

**`src/types.ts`** — added `HistoryLoadMessage` and added it to the `ServerMessage` union:

```ts
export interface HistoryLoadMessage {
  type: 'history_load';
  session_id: string;
  turns: Array<{ role: 'user' | 'assistant'; content: string; session_id: string; ts: number }>;
}
```

**`src/messageHandler.ts`** — `import { appendTurn } from './contextStore';`. Two persistence seams:
- `whisper_final` case, right after `ctx.conversationHistory.push({ role: 'user', content: text })`:
  `appendTurn(ctx.sessionId, 'user', text);`
- `llm_stream_complete` case, at the top:
  `const fullText = (p?.fullText as string) ?? ''; if (fullText.trim()) { appendTurn(ctx.sessionId, 'assistant', fullText.trim()); }`
  — this event carries `fullText` for **both** Groq and Gemini (wired in `sideEffects.ts`
  `triggerLLMStream` → `emit('llm_stream_complete', { fullText: ev.fullText })`), so persistence is
  backend-agnostic and lives in one place. The tool-call path sends empty text here and is intentionally
  not persisted.

**`src/server.ts`** — `import { initContextStore, loadRecentTurns } from './contextStore';`; call
`initContextStore()` after the "WebSocket server listening" log; and right after sending `session_ack`,
send the transcript so the client can populate the sidebar:

```ts
const pastTurns = loadRecentTurns();
if (pastTurns.length > 0) {
  const history: ServerMessage = { type: 'history_load', session_id: sessionId, turns: pastTurns };
  ws.send(JSON.stringify(history));
  console.log(`[server] Sent ${pastTurns.length} past turns to session ${sessionId}`);
}
```

**`package.json`** — added `"better-sqlite3": "^11.8.1"` (deps) and `"@types/better-sqlite3": "^7.6.11"`
(devDeps). **The user must run `npm install better-sqlite3` on real hardware** — it could not be
installed in the sandbox (no network). Until then the store self-disables and history is empty (fine).

**`.gitignore`** — added `data/` (the SQLite file is local user data, never committed).

**`client/src/protocol.ts`** — client mirror of the server type. Added `PersistedTurn` and the
`| { type: 'history_load'; session_id: string; turns: PersistedTurn[] }` arm to `ServerMessage`.
**This is the only client-side part of #4 done so far.**

---

## 6. Remaining work — do in this order

### 6.1 Finish Fix #2 (assistant caption synced to audio)

**Goal:** the assistant's words appear progressively *in step with Piper's voice*, not all at once.
Approach: don't reveal until the first audio chunk of the reply has arrived, then pace each word so the
text finishes about when the buffered audio finishes. Include a stall fallback so text still reveals if
TTS produces no audio at all.

**`client/src/components/Captions.tsx` — `AssistantCaption`:**
- Add props: `audioStarted: boolean` and `remainingMs: () => number`.
- Replace the fixed-`WORD_MS` effect with a paced one. Suggested constants:
  `const MIN_WORD_MS = 55;` (drain fast when audio is nearly done),
  `const MAX_WORD_MS = 420;` (don't crawl),
  `const STALL_MS = 1800;` (if no audio after this long, reveal anyway at a readable ~300 ms/word).
- Reveal gate: while `!audioStarted`, only start revealing once `STALL_MS` has elapsed since mount
  (use a mounted-time ref + timer). Once `audioStarted` is true, reveal immediately.
- Per-word delay when audio is playing:
  `const remainingWords = words.length - shown;`
  `const perWord = remainingWords > 0 ? clamp(remainingMs() / remainingWords, MIN_WORD_MS, MAX_WORD_MS) : MIN_WORD_MS;`
  Schedule the next `setShown(n => n+1)` after `perWord`. As `remainingMs()` → 0 the tail drains at
  `MIN_WORD_MS` (no freeze). When stalled (no audio), use ~300 ms.
- Keep the existing `catchingUp` caret and the sources list unchanged. Keep the `key={replyId}` remount
  reset (App already does this) — that resets `shown` to 0 each reply.
- **Hook rule:** all timer scheduling stays inside `useEffect`; never write refs during render.

**`client/src/App.tsx`:**
- `const { enqueue, flush, remainingMs, speaking, analyserRef } = playback;` (add `remainingMs`).
- Add `const [audioStarted, setAudioStarted] = useState(false);` and an `audioStartedRef` mirror
  (updated in an effect, per the ref-write rule).
- In `onMessage`, `case 'transcript_final':` also do `setAudioStarted(false);` (new reply → no audio yet).
- Wrap the audio handler so the first chunk flips the flag:
  ```ts
  const onAudio = useCallback((frame: ArrayBuffer) => {
    if (!audioStartedRef.current) setAudioStarted(true);
    enqueue(frame);
  }, [enqueue]);
  ```
  and pass `onAudio` (not `enqueue`) to `useWsClient({ …, onAudio, … })`.
- Pass the two new props: `<AssistantCaption key={replyId} text={assistantText} sources={sources} audioStarted={audioStarted} remainingMs={remainingMs} />`.

**Fallback the user explicitly allowed:** if syncing proves flaky, just slow the fixed reveal
(e.g. `WORD_MS` ≈ 150–170 to roughly match Piper's ~150 wpm). Prefer the synced version; keep this in
your back pocket.

### 6.2 Fix #3 (scrollable stage, last 5 per side, top fade)

**Goal:** each side becomes a scrollable column. The newest exchange sits centered (current behavior);
older turns stack above and fade toward the top; the user can scroll to see up to **5 previous messages
per side**; when new text starts on either side, both columns snap back to the newest.

**Model (in `App.tsx`):** introduce a UI history array — **name it to avoid the existing `Turn` type**
in `protocol.ts` (which is `'idle'|'listening'|'thinking'|'speaking'`). Suggested:
```ts
interface StageTurn { id: number; role: 'user' | 'assistant'; text: string; sources?: GroundingSource[]; }
```
Keep the current live `userText`/`assistantText` as the in-progress turn. When a new utterance begins
(next `transcript_final`), archive the just-finished pair into `history` (cap each side to the last 5 —
store combined and slice per role when rendering, or keep two arrays). A `turnCompleteRef` + `liveRef`
pattern avoids stale-closure archiving.

**Component:** add `TranscriptSide` (one per side):
- Outer label sits **outside** the scroll area (so it doesn't scroll away).
- Scroll container `.transcript`: `overflow-y:auto`, bottom-anchored via `margin-top:auto` on the inner
  list (so the newest sits at the bottom/center), and a top fade using
  `mask-image: linear-gradient(to bottom, transparent, black 3rem);` (+ `-webkit-mask-image`).
- Previous turns render as static `.bubble`s; the live turn stays the animated caption.
- Auto-scroll to newest with a `ResizeObserver`/effect that sets `el.scrollTop = el.scrollHeight`
  whenever a new turn is appended or the live text grows (mirror the `LogSidebar` tail-follow pattern).
- Respect `prefers-reduced-motion`.

**CSS:** add `.transcript`, `.bubble`, and side modifiers to `index.css`, matching the existing tokens
and the mono(user)/serif(assistant) split. Keep the 3-column `.stage` grid
(`1fr min(46vmin,420px) 1fr`, `align-items:center`) — the side columns become the scrollable regions.

### 6.3 Fix #4 client half (history sidebar)

Server + `protocol.ts` are done (§5). Remaining:
- **`App.tsx`:** add `const [history, setHistory] = useState<PersistedTurn[]>([])` for the DB transcript
  (separate from the stage model in §6.2 — this one is the full, cross-session log). Handle the new
  message: `case 'history_load': setHistory(msg.turns); break;`. Also append the live user/assistant
  turns to this list as they finalize, so the sidebar reflects the current session in real time (the DB
  already has them after the server persists; appending client-side avoids a round-trip).
- **`HistorySidebar` component** (model it on `LogSidebar.tsx`): a slide-out panel of chat bubbles,
  chronological, user vs assistant styled differently. **Session dividers:** when
  `turns[i].session_id !== turns[i-1].session_id`, render a thin rule between them (the user's
  clarification: "one running transcript, just add a line between session to session"). It **slides from
  the LEFT** because the Log panel already occupies the right (`translate:-100% 0` → `.is-open{translate:0 0}`).
  Escape closes it.
- **Rail toggle:** add a "History" button next to "Log" in the `.rail` header, backed by
  `const [historyOpen, setHistoryOpen] = useState(false)`.
- **CSS:** add `.history` (mirror `.logs`, but anchored left).

### 6.4 Verify + docs (do before declaring the 4 fixes done)

- Run the full green gate (§7).
- Update `PROGRESS.md` (mark the four fixes; note R-Phase 3/4 next) and `.claude/todo.md`
  (remember: `.claude/` is Write-blocked in the sandbox — use outputs + `cp` there; on the user's own
  machine normal edits are fine).
- Add ADRs to `.claude/decisions.md` for the notable choices (audio-synced caption reveal; single
  running transcript with session dividers; better-sqlite3 + graceful disable).
- Save/refresh any relevant memory.

### 6.5 R-Phase 3 — persistent cross-session context (after the 4 fixes)

The store from §5 is display-only so far. Phase 3 makes the **LLM remember across sessions**:
- On connect, hydrate `session.ts` `conversationHistory` from `contextStore.loadRecentTurns()` —
  inject `system + rolling summary + last K turns` (not the whole log; keep prefill bounded).
- Add `src/summarizer.ts`: an **off-hot-path** rolling summary via Groq (don't block a turn on it).
- **Open questions to confirm with the user (or take sensible defaults):** value of `K` (verbatim recent
  turns) and the summary trigger threshold. See `.claude/plan.md` §6.3, `.claude/architecture.md` §5.3.
- Note `groqStream.ts` already caps history to `MAX_HISTORY_MESSAGES = 8` for TTFT — reconcile K with
  that cap.

### 6.6 R-Phase 4 — barge-in (after Phase 3)

- Relax `micGated()` so the mic stays live during `TTS_STREAMING` (today it's gated the whole turn, D7).
- Add pure `src/intentClassifier.ts` → `backchannel | stop | substantive`.
- Feed resolved `barge_in_confirmed` / `stop_requested` into the pure state machine; unify
  `LLM_STREAMING` + `TTS_STREAMING` interruption handling.
- Regeneration path: abort LLM + flush TTS + start a new turn from the interrupting utterance.
- Self-echo mitigation: onset guard + energy threshold (assumes headphones, D7).
- See `.claude/plan.md` §6.2, `.claude/architecture.md` §5.2.

---

## 7. Verification commands (the "green gate")

```bash
# Server (repo root)
npx tsc --noEmit          # expect: exit 0
npm test                  # jest --runInBand --forceExit → expect 3 suites / 57 tests pass

# Client
cd client
npm run build             # tsc -b + vite → expect clean
npx eslint .              # expect clean
```

Run all four after finishing §6.1–6.3. Current baseline: server tsc + tests already green; client not
re-run since the (minimal, type-clean) client edits.

**Runtime (user hardware only — needs network + models + mic):**
`npm install better-sqlite3`; download a Vosk model to `VOSK_MODEL_PATH`; `cd client && npm run build`;
`npm start`; then walk the observational checks (orb waves on both voices, live user captions, assistant
caption tracks TTS audio, Mute produces zero frames, sidebar shows history across a restart).

---

## 8. Key files map

**Server (`src/`):**
`server.ts` (WS + static HTTP, session_ack, history_load) · `messageHandler.ts` (WS + internal event
routing; persistence seams) · `stateMachine.ts` (pure transitions) · `sideEffects.ts` (named effect
dispatcher; `triggerLLMStream`) · `session.ts` (singleton `SessionStore`, `conversationHistory`) ·
`types.ts` (wire contract, server side) · `contextStore.ts` (**new** SQLite) · `groqStream.ts` /
`geminiStream.ts` (LLM streaming) · `sharedState.ts` (active sentence buffer) · `whisperProcess.ts` /
`voskProcess.ts` / `piperProcess.ts` (subprocess wrappers).

**Client (`client/src/`):**
`App.tsx` (owns state, wires hooks — central file for #2/#3/#4) · `protocol.ts` (wire contract, client
mirror — keep in sync with `src/types.ts`) · `components/Captions.tsx` (User/Assistant captions) ·
`components/Orb.tsx` · `components/Controls.tsx` · `components/LogSidebar.tsx` (**pattern to copy for
`HistorySidebar`**) · `hooks/useAudioPlayback.ts` (TTS scheduler + `remainingMs`) · `hooks/useWsClient.ts`
(`onMessage`/`onAudio`/`onClosed`) · `hooks/useVadMic.ts` · `hooks/useOrbLevel.ts` · `index.css` (tokens
+ all component CSS).

**Docs:** `PRD.md`, `PRD_v2.md`, `PROGRESS.md`, `.claude/{plan,architecture,decisions,todo}.md`, `CLAUDE.md`.

---

## 9. Decisions relevant to this work

- **D7** — Half-duplex until barge-in; assume headphones for echo.
- **D10** — Never persist audio; text only. (Governs the SQLite store's scope.)
- **D12** — Execution order: Live STT → Frontend → Persistent context → Barge-in.
- **D13/D14** — Live STT fans out at existing seams; subprocess wrappers self-disable when their model
  is missing (the pattern `contextStore.ts` copies).
- **This batch (propose as new ADRs in §6.4):**
  - Caption reveal is **paced to buffered TTS audio** (`remainingMs`), with a stall fallback; the user
    pre-approved a "just slow the fixed reveal" fallback if syncing is flaky.
  - History sidebar is **one running chronological transcript with session dividers**, not a
    multi-conversation list (user's explicit choice).
  - Context store uses **better-sqlite3** (user's choice) with a dynamic-`require` graceful-disable so
    tsc/tests stay green without the native module installed.
  - Persistence centralized in `messageHandler.ts` (user turn @ `whisper_final`, assistant turn @
    `llm_stream_complete` reading `fullText`) — one site per role, backend-agnostic.

---

## 10. Raw transcript

The pre-compaction chat log (if you want the unabridged history) is at:
`/home/piyush-bhatt/.config/Claude-3p/local-agent-mode-sessions/0f19fca7/00000000/22b43567/.claude/projects/-home-piyush-bhatt--config-Claude-3p-local-agent-mode-sessions-0f19fca7-00000000-22b43567-outputs/ac94031b-e486-4d5d-83a4-a425f5e4b008.jsonl`

Everything needed to continue is in §1–§9; the transcript is only for archaeology.
