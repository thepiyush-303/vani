// ============================================================
// App — owns the two state axes and wires the hooks together.
//
//   connection: disconnected | connecting | connected   (the socket)
//   turn:       idle | listening | thinking | speaking  (what's happening)
//
// The mic may capture only when connected and unmuted. Those are separate on
// purpose: connecting is a deliberate act, and opening the mic is another one.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { AssistantCaption, TranscriptSide, UserCaption } from './components/Captions.tsx';
import { Controls } from './components/Controls.tsx';
import { HistorySidebar } from './components/HistorySidebar.tsx';
import { LogSidebar } from './components/LogSidebar.tsx';
import { Orb } from './components/Orb.tsx';
import { useAudioPlayback } from './hooks/useAudioPlayback.ts';
import { useOrbLevel, type LevelSource } from './hooks/useOrbLevel.ts';
import { useVadMic } from './hooks/useVadMic.ts';
import { useWsClient } from './hooks/useWsClient.ts';
import { turnFor, type GroundingSource, type LogEntry, type LogKind, type PersistedTurn, type ServerMessage, type ServerState } from './protocol.ts';

/** Log entries kept in memory. Old lines are dropped, not persisted. */
const MAX_LOG = 300;

/** Settled turns each side of the stage keeps for scroll-back (Fix #3). */
const HISTORY_PER_SIDE = 5;

export default function App() {
  const [serverState, setServerState] = useState<ServerState | null>(null);
  const [muted, setMuted] = useState(true);
  const [userText, setUserText] = useState('');
  const [userFinal, setUserFinal] = useState(false);
  const [assistantText, setAssistantText] = useState('');
  const [replyId, setReplyId] = useState(0);
  const [sources, setSources] = useState<GroundingSource[]>([]);
  // Flips true on the first TTS audio chunk of a reply; paces the assistant
  // caption reveal (Fix #2). Reset on each new transcript_final.
  const [audioStarted, setAudioStarted] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logsOpen, setLogsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  // Stage scroll-back: the last few settled turns per side (Fix #3).
  const [userHistory, setUserHistory] = useState<string[]>([]);
  const [assistantHistory, setAssistantHistory] = useState<string[]>([]);
  // The durable, cross-session transcript shown in the sidebar (Fix #4). Seeded
  // from the server on connect, then appended to as this session goes.
  const [history, setHistory] = useState<PersistedTurn[]>([]);

  // Refs for stale-closure-safe access to live text (used for archiving).
  const userTextRef = useRef(userText);
  const assistantTextRef = useRef(assistantText);
  const sessionIdRef = useRef('');
  useEffect(() => { userTextRef.current = userText; });
  useEffect(() => { assistantTextRef.current = assistantText; });

  const logIdRef = useRef(0);
  const log = useCallback((text: string, kind: LogKind = 'sys') => {
    const at = new Date().toISOString().slice(11, 23);
    const entry: LogEntry = { id: logIdRef.current++, at, kind, text };
    setLogs((prev) => (prev.length < MAX_LOG ? [...prev, entry] : [...prev.slice(-(MAX_LOG - 1)), entry]));
  }, []);

  const playback = useAudioPlayback(log);
  const { enqueue, flush, remainingMs, speaking, analyserRef } = playback;

  // useWsClient needs this, and this needs useWsClient's disconnect. The ref
  // breaks the cycle; it is assigned right after the hook runs.
  const disconnectRef = useRef<() => void>(() => {});

  const onMessage = useCallback(
    (msg: ServerMessage) => {
      switch (msg.type) {
        case 'session_ack':
          setServerState(msg.state);
          sessionIdRef.current = msg.session_id;
          log(`session up — server ${msg.server_version}, tts ${msg.tts_sample_rate}Hz`, 'in');
          break;
        case 'state_change':
          setServerState(msg.to);
          log(`${msg.from} → ${msg.to}`, 'in');
          break;
        case 'transcript_partial':
          setUserText(msg.text);
          setUserFinal(false);
          break;
        case 'transcript_final': {
          // Archive the just-finished assistant text as a settled bubble (Fix #3).
          const prevAssistant = assistantTextRef.current.trim();
          if (prevAssistant) {
            setAssistantHistory((h) => [...h.slice(-(HISTORY_PER_SIDE - 1)), prevAssistant]);
          }
          // Archive the previous user text too (the one the assistant just replied to).
          const prevUser = userTextRef.current.trim();
          if (prevUser) {
            setUserHistory((h) => [...h.slice(-(HISTORY_PER_SIDE - 1)), prevUser]);
          }
          setUserText(msg.text);
          setUserFinal(true);
          // A final transcript is the start of a reply, so clear the last one.
          // Bumping the id remounts the caption, which resets its reveal.
          setAssistantText('');
          setReplyId((n) => n + 1);
          setSources([]);
          setAudioStarted(false);
          log(`heard: "${msg.text}" (${msg.duration_ms}ms)`, 'in');
          break;
        }
        case 'llm_token':
          setAssistantText((prev) => prev + msg.delta);
          break;
        case 'tool_call':
          log(`tool: ${msg.tool_name}`, 'in');
          break;
        case 'tts_interrupted':
          flush();
          log('playback stopped — interrupted', 'in');
          break;
        case 'turn_complete': {
          setServerState('IDLE');
          log(`turn complete (${msg.total_latency_ms}ms, ${msg.token_count} tokens)`, 'in');
          // Append finalized turns to the sidebar history so the current session
          // shows up without waiting for a reconnect (Fix #4).
          const uText = userTextRef.current.trim();
          const aText = assistantTextRef.current.trim();
          const sid = sessionIdRef.current;
          const now = Date.now();
          if (uText) setHistory((h) => [...h, { role: 'user', content: uText, session_id: sid, ts: now - 1 }]);
          if (aText) setHistory((h) => [...h, { role: 'assistant', content: aText, session_id: sid, ts: now }]);
          break;
        }
        case 'grounding_sources':
          setSources(msg.sources);
          log(`${msg.sources.length} source(s) cited`, 'in');
          break;
        case 'error':
          log(`${msg.code}: ${msg.message}`, 'err');
          if (!msg.recoverable) disconnectRef.current();
          break;
        case 'history_load':
          setHistory(msg.turns);
          sessionIdRef.current = msg.session_id;
          log(`loaded ${msg.turns.length} past turn(s)`, 'in');
          break;
      }
    },
    [flush, log],
  );

  // Closing the socket — for any reason, including the server dropping it —
  // closes the mic with it.
  const onClosed = useCallback(() => {
    setMuted(true);
    setServerState(null);
  }, []);

  // The first audio chunk of a reply flips audioStarted so the assistant caption
  // starts revealing in step with the voice. setState is idempotent, so the
  // later chunks are no-ops.
  const onAudio = useCallback(
    (frame: ArrayBuffer) => {
      setAudioStarted(true);
      enqueue(frame);
    },
    [enqueue],
  );

  const ws = useWsClient({ onMessage, onAudio, onClosed, log });
  useEffect(() => {
    disconnectRef.current = ws.disconnect;
  });

  const connected = ws.connection === 'connected';
  const canCapture = connected && !muted;

  // The mic is ignored while the assistant's audio is playing and for the rest
  // of the server's turn, so neither our own voice nor room noise can start a
  // new turn. Half-duplex until barge-in lands (D7).
  const gated = speaking || (serverState !== null && serverState !== 'IDLE' && serverState !== 'LISTENING');
  const gatedRef = useRef(gated);
  useEffect(() => {
    gatedRef.current = gated;
  });

  const micLevelRef = useVadMic({
    active: canCapture,
    gatedRef,
    sessionIdRef: ws.sessionId,
    sendJson: ws.send,
    sendPcm: ws.sendPcm,
    log,
  });

  const source: LevelSource = speaking ? 'tts' : canCapture ? 'mic' : 'none';
  const readLevel = useOrbLevel(micLevelRef, analyserRef, source);

  const turn = speaking ? 'speaking' : serverState ? turnFor(serverState) : 'idle';
  const status =
    ws.connection === 'disconnected'
      ? 'Offline'
      : ws.connection === 'connecting'
        ? 'Connecting'
        : muted
          ? 'Mic off'
          : turn === 'listening'
            ? 'Listening'
            : turn === 'thinking'
              ? 'Thinking'
              : turn === 'speaking'
                ? 'Speaking'
                : 'Ready';

  const placeholder = !connected ? 'Not connected.' : muted ? 'Mic is off.' : 'Say something.';

  return (
    <div className="app">
      <header className="rail">
        <span className="rail__mark">Vani</span>
        <span className="rail__rule" aria-hidden="true" />
        <span className="rail__meta">16 kHz · 512-sample frames</span>
        <button className="rail__toggle" onClick={() => setHistoryOpen((o) => !o)} aria-expanded={historyOpen}>
          History
        </button>
        <button className="rail__toggle" onClick={() => setLogsOpen((o) => !o)} aria-expanded={logsOpen}>
          Log
        </button>
      </header>

      <main className="stage">
        <TranscriptSide variant="user" label="You" history={userHistory}>
          <UserCaption text={userText} final={userFinal} placeholder={placeholder} />
        </TranscriptSide>
        <div className="stage__orb">
          <Orb readLevel={readLevel} source={source} dim={!connected} />
        </div>
        <TranscriptSide variant="assistant" label="Vani" history={assistantHistory}>
          <AssistantCaption key={replyId} text={assistantText} sources={sources} audioStarted={audioStarted} remainingMs={remainingMs} />
        </TranscriptSide>
      </main>

      <footer className="foot">
        <Controls
          connection={ws.connection}
          muted={muted}
          status={status}
          onToggleConnection={() => (connected || ws.connection === 'connecting' ? ws.disconnect() : ws.connect())}
          onToggleMute={() => setMuted((m) => !m)}
        />
      </footer>

      <HistorySidebar turns={history} open={historyOpen} onClose={() => setHistoryOpen(false)} />
      <LogSidebar entries={logs} open={logsOpen} onClose={() => setLogsOpen(false)} />
    </div>
  );
}
