"use strict";
// ============================================================
// server.ts — WebSocket server + HTTP static file server
// WS on PORT (default 8765), HTTP on HTTP_PORT (default 3000)
// ============================================================
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.wss = void 0;
require("dotenv/config");
const ws_1 = require("ws");
const uuid_1 = require("uuid");
const http = __importStar(require("http"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const session_1 = require("./session");
const messageHandler_1 = require("./messageHandler");
const sideEffects_1 = require("./sideEffects");
const whisperProcess = __importStar(require("./whisperProcess"));
const piperProcess = __importStar(require("./piperProcess"));
const PORT = parseInt(process.env.PORT ?? '8765', 10);
const HTTP_PORT = parseInt(process.env.HTTP_PORT ?? '3000', 10);
const SERVER_VERSION = '0.1.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const wss = new ws_1.WebSocketServer({ port: PORT });
exports.wss = wss;
// ── HTTP static file server (serves public/) ──────────────────
const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.ico': 'image/x-icon',
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
(0, sideEffects_1.initSubprocesses)((eventType, payload) => {
    const ctx = session_1.SessionStore.get();
    if (!ctx)
        return; // no active session — discard event
    const ws = activeWs;
    if (!ws || ws.readyState !== ws_1.WebSocket.OPEN)
        return;
    (0, messageHandler_1.handleInternalEvent)(eventType, payload, ws, ctx);
});
// Track the currently active WS connection for subprocess callbacks
let activeWs = null;
wss.on('connection', (ws) => {
    // ── Single-session guard ───────────────────────────────────
    if (session_1.SessionStore.has()) {
        console.warn('[server] Rejected new connection — a session is already active');
        ws.send(JSON.stringify({
            type: 'error',
            session_id: '',
            code: 'INTERNAL',
            message: 'Server already has an active session. Only one session is supported.',
            recoverable: false,
            timestamp_ms: Date.now(),
        }));
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
            let initMsg;
            try {
                initMsg = JSON.parse(data.toString());
            }
            catch {
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
            const sessionId = initMsg.session_id ?? (0, uuid_1.v4)();
            const ctx = (0, session_1.createSession)(sessionId);
            session_1.SessionStore.set(ctx);
            initialized = true;
            clearTimeout(initTimeout);
            console.log(`[server] Session ${sessionId} initialized`);
            // ── Send session_ack ───────────────────────────────────
            const ack = {
                type: 'session_ack',
                session_id: sessionId,
                server_version: SERVER_VERSION,
                tts_sample_rate: 22050,
                state: ctx.state,
            };
            ws.send(JSON.stringify(ack));
            // ── Register post-init message handler ────────────────
            ws.on('message', (msgData, msgIsBinary) => {
                if (!initialized)
                    return;
                const currentCtx = session_1.SessionStore.getOrThrow();
                if (msgIsBinary) {
                    (0, messageHandler_1.handleBinaryMessage)(msgData, ws, currentCtx);
                }
                else {
                    (0, messageHandler_1.handleTextMessage)(msgData.toString(), ws, currentCtx);
                }
            });
            return;
        }
    });
    // ── Connection teardown ────────────────────────────────────
    ws.on('close', (code, reason) => {
        clearTimeout(initTimeout);
        const sessionId = session_1.SessionStore.get()?.sessionId ?? 'unknown';
        console.log(`[server] Connection closed — session=${sessionId} code=${code} reason=${reason.toString() || '(none)'}`);
        session_1.SessionStore.clear();
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
//# sourceMappingURL=server.js.map