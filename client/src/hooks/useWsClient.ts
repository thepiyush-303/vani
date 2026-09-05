// ============================================================
// useWsClient — the single WebSocket to the agent server.
//
// Owns the connection lifecycle and the session_init handshake, and demuxes
// the two kinds of inbound frame: JSON control messages and binary TTS audio.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { SAMPLE_RATE, type ClientMessage, type Connection, type ServerMessage } from '../protocol.ts';

// The WS port is fixed by the server (PORT, default 8765). The host is taken
// from the page so this works both from the Vite dev server and from the Node
// static server, and over the network rather than only on localhost.
const WS_URL = `ws://${window.location.hostname}:8765`;

interface Options {
  onMessage: (msg: ServerMessage) => void;
  onAudio: (frame: ArrayBuffer) => void;
  /** The socket is gone — for any reason, including the server dropping it. */
  onClosed: () => void;
  log: (text: string, kind?: 'sys' | 'in' | 'out' | 'err') => void;
}

export function useWsClient(opts: Options) {
  const [connection, setConnection] = useState<Connection>('disconnected');
  const wsRef = useRef<WebSocket | null>(null);
  const sessionIdRef = useRef<string>('');

  // Handlers are re-created on every App render; read them through a ref so a
  // render never tears down a live socket.
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  });

  const send = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(msg));
    optsRef.current.log(`→ ${msg.type}`, 'out');
  }, []);

  const sendPcm = useCallback((pcm: Int16Array) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(pcm.buffer as ArrayBuffer);
  }, []);

  const disconnect = useCallback(() => {
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws) {
      ws.onclose = null; // we are the ones closing; report it once, below
      ws.close();
    }
    setConnection('disconnected');
    optsRef.current.onClosed();
  }, []);

  const connect = useCallback(() => {
    if (wsRef.current) return;

    const sessionId = crypto.randomUUID();
    sessionIdRef.current = sessionId;
    setConnection('connecting');
    optsRef.current.log(`connecting to ${WS_URL}`, 'sys');

    let ws: WebSocket;
    try {
      ws = new WebSocket(WS_URL);
    } catch {
      optsRef.current.log('could not open a socket to the agent server', 'err');
      setConnection('disconnected');
      return;
    }
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.onopen = () => {
      // PRD §3.3.1 — session_init is sent once, immediately.
      ws.send(
        JSON.stringify({
          type: 'session_init',
          session_id: sessionId,
          audio_format: { sample_rate: SAMPLE_RATE, channels: 1, bit_depth: 16, encoding: 'pcm_s16le' },
          client_capabilities: {
            supports_barge_in: true,
            vad_library: 'silero-v5',
            browser: navigator.userAgent.slice(0, 60),
          },
        } satisfies ClientMessage),
      );
      optsRef.current.log('→ session_init', 'out');
    };

    ws.onmessage = (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) {
        optsRef.current.onAudio(event.data);
        return;
      }
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        optsRef.current.log(`unreadable message: ${String(event.data).slice(0, 80)}`, 'err');
        return;
      }
      // The handshake completes on session_ack, not on open — until the server
      // has a session there is nothing to talk to.
      if (msg.type === 'session_ack') setConnection('connected');
      optsRef.current.onMessage(msg);
    };

    ws.onclose = (event: CloseEvent) => {
      wsRef.current = null;
      setConnection('disconnected');
      optsRef.current.log(`connection closed (${event.code})`, 'sys');
      optsRef.current.onClosed();
    };

    ws.onerror = () => {
      optsRef.current.log(`no response from ${WS_URL} — is the agent server running?`, 'err');
    };
  }, []);

  // Close the socket if the page goes away mid-session.
  useEffect(() => {
    return () => {
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, []);

  return { connection, sessionId: sessionIdRef, connect, disconnect, send, sendPcm };
}
