// ============================================================
// server.ts — WebSocket server + HTTP static file server
// WS on PORT (default 8765), HTTP on HTTP_PORT (default 3000)
// ============================================================

import 'dotenv/config';
import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { SessionInitMessage, ServerMessage } from './types';
import { createSession, SessionStore } from './session';
import { handleTextMessage, handleBinaryMessage, handleInternalEvent } from './messageHandler';
import { initSubprocesses } from './sideEffects';
import * as whisperProcess from './whisperProcess';
import * as piperProcess from './piperProcess';

const PORT = parseInt(process.env.PORT ?? '8765', 10);
const HTTP_PORT = parseInt(process.env.HTTP_PORT ?? '3000', 10);
const SERVER_VERSION = '0.1.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');


const wss = new WebSocketServer({ port: PORT });

// ── HTTP static file server (serves public/) ──────────────────
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.ico':  'image/x-icon',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
};

const httpServer = http.createServer((req, res) => {
  const urlPath = req.url === '/' ? '/index.html' : (req.url ?? '/index.html');
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath));

  // Security: prevent directory traversal outside public/
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500);
      res.end(err.code === 'ENOENT' ? 'Not Found' : 'Server Error');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

httpServer.listen(HTTP_PORT, () => {
  console.log(`[server] HTTP static server listening on http://localhost:${HTTP_PORT}`);
});

console.log(`[server] WebSocket server listening on port ${PORT}`);

// ── Initialize subprocesses (Whisper + Piper) ─────────────────
// Wire internal Whisper transcript events through the state machine.
initSubprocesses((eventType, payload) => {
  const ctx = SessionStore.get();
  if (!ctx) return;  // no active session — discard event
  const ws = activeWs;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  handleInternalEvent(eventType, payload, ws, ctx);
});

// Track the currently active WS connection for subprocess callbacks
let activeWs: WebSocket | null = null;

wss.on('connection', (ws: WebSocket) => {
  // ── Single-session guard ───────────────────────────────────
  if (SessionStore.has()) {
    console.warn('[server] Rejected new connection — a session is already active');
    ws.send(JSON.stringify({
      type: 'error',
      session_id: '',
      code: 'INTERNAL',
      message: 'Server already has an active session. Only one session is supported.',
      recoverable: false,
      timestamp_ms: Date.now(),
    } satisfies ServerMessage));
    ws.close();
    return;
  }

  // Track this connection for subprocess callbacks
  activeWs = ws;
  console.log('[server] Client connected — waiting for session_init');

  // ── Wait for session_init handshake ──────────────────────
  let initialized = false;

  // Timeout: close connection if session_init not received within 10s
  const initTimeout = setTimeout(() => {
    if (!initialized) {
      console.warn('[server] session_init timeout — closing connection');
      ws.close();
    }
  }, 10_000);

  ws.on('message', (data, isBinary) => {
    // ── Pre-init: accept only session_init ──────────────────
    if (!initialized) {
      if (isBinary) {
        console.warn('[server] Binary frame received before session_init — ignoring');
        return;
      }

      let initMsg: SessionInitMessage;
      try {
        initMsg = JSON.parse(data.toString()) as SessionInitMessage;
      } catch {
        console.error('[server] Malformed session_init JSON — closing');
        ws.close();
        return;
      }

      if (initMsg.type !== 'session_init') {
        console.warn(`[server] Expected session_init, got: ${initMsg.type} — closing`);
        ws.close();
        return;
      }

      // ── Create session ─────────────────────────────────────
      const sessionId = initMsg.session_id ?? uuidv4();
      const ctx = createSession(sessionId);
      SessionStore.set(ctx);
      initialized = true;
      clearTimeout(initTimeout);

      console.log(`[server] Session ${sessionId} initialized`);

      // ── Send session_ack ───────────────────────────────────
      const ack: ServerMessage = {
        type: 'session_ack',
        session_id: sessionId,
        server_version: SERVER_VERSION,
        tts_sample_rate: 22050,
        state: ctx.state,
      };
      ws.send(JSON.stringify(ack));

      // ── Register post-init message handler ────────────────
      ws.on('message', (msgData, msgIsBinary) => {
        if (!initialized) return;
        const currentCtx = SessionStore.getOrThrow();

        if (msgIsBinary) {
          handleBinaryMessage(msgData as Buffer, ws, currentCtx);
        } else {
          handleTextMessage(msgData.toString(), ws, currentCtx);
        }
      });

      return;
    }
  });

  // ── Connection teardown ────────────────────────────────────
  ws.on('close', (code, reason) => {
    clearTimeout(initTimeout);
    const sessionId = SessionStore.get()?.sessionId ?? 'unknown';
    console.log(`[server] Connection closed — session=${sessionId} code=${code} reason=${reason.toString() || '(none)'}`);
    SessionStore.clear();
    activeWs = null;
    initialized = false;
  });

  ws.on('error', (err) => {
    console.error(`[server] WebSocket error: ${err.message}`);
    // Connection will emit 'close' after this, which handles cleanup
  });
});

wss.on('error', (err) => {
  console.error(`[server] WebSocketServer fatal error: ${err.message}`);
  process.exit(1);
});

// ── Graceful shutdown ──────────────────────────────────────────
process.on('SIGINT', () => {
  console.log('\n[server] SIGINT received — shutting down gracefully');
  whisperProcess.stop();
  piperProcess.stop();
  httpServer.close();
  wss.close(() => {
    console.log('[server] Server closed');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  console.log('[server] SIGTERM received — shutting down gracefully');
  whisperProcess.stop();
  piperProcess.stop();
  httpServer.close();
  wss.close(() => process.exit(0));
});

export { wss };
