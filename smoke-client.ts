// ============================================================
// smoke-client.ts — Phase 1 integration smoke test
// Run: npx ts-node smoke-client.ts
// Expects server running on ws://localhost:8765
// ============================================================

import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';

const WS_URL = process.env.WS_URL ?? 'ws://localhost:8765';
const SESSION_ID = uuidv4();
const TIMEOUT_MS = 5000;

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${label}`);
    failed++;
  }
}

function waitForMessage(
  ws: WebSocket,
  predicate: (msg: Record<string, unknown>) => boolean,
  timeoutMs = TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for message (${timeoutMs}ms)`));
    }, timeoutMs);

    function onMessage(data: WebSocket.RawData) {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (predicate(msg)) {
          clearTimeout(timer);
          ws.off('message', onMessage);
          resolve(msg);
        }
      } catch {
        // ignore parse errors from other messages
      }
    }

    ws.on('message', onMessage);
  });
}

async function runSmoke(): Promise<void> {
  console.log(`\n🔌 Connecting to ${WS_URL} …\n`);

  const ws = new WebSocket(WS_URL);

  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  console.log('Connected.\n');

  // ── 1. Send session_init ───────────────────────────────────
  ws.send(JSON.stringify({
    type: 'session_init',
    session_id: SESSION_ID,
    audio_format: { sample_rate: 16000, channels: 1, bit_depth: 16, encoding: 'pcm_s16le' },
    client_capabilities: { supports_barge_in: true, vad_library: 'silero-v5', browser: 'smoke-client' },
  }));

  // ── 2. Expect session_ack ─────────────────────────────────
  const ack = await waitForMessage(ws, m => m.type === 'session_ack');
  assert(ack.type === 'session_ack', 'session_ack received');
  assert(ack.state === 'IDLE', `session_ack.state === "IDLE" (got "${ack.state}")`);
  assert(ack.session_id === SESSION_ID, 'session_ack.session_id matches');
  assert(typeof ack.tts_sample_rate === 'number' && ack.tts_sample_rate === 22050, 'tts_sample_rate = 22050');
  console.log('');

  // ── 3. speech_start → expect IDLE → LISTENING ────────────
  ws.send(JSON.stringify({ type: 'speech_start', session_id: SESSION_ID, timestamp_ms: Date.now() }));

  const sc1 = await waitForMessage(ws, m => m.type === 'state_change');
  assert(sc1.type === 'state_change', 'state_change received after speech_start');
  assert(sc1.from === 'IDLE', `state_change.from === "IDLE" (got "${sc1.from}")`);
  assert(sc1.to === 'LISTENING', `state_change.to === "LISTENING" (got "${sc1.to}")`);
  console.log('');

  // ── 4. speech_end → expect LISTENING → TRANSCRIBING ──────
  await new Promise(r => setTimeout(r, 100)); // simulate utterance duration
  ws.send(JSON.stringify({ type: 'speech_end', session_id: SESSION_ID, duration_ms: 100, timestamp_ms: Date.now() }));

  const sc2 = await waitForMessage(ws, m => m.type === 'state_change');
  assert(sc2.type === 'state_change', 'state_change received after speech_end');
  assert(sc2.from === 'LISTENING', `state_change.from === "LISTENING" (got "${sc2.from}")`);
  assert(sc2.to === 'TRANSCRIBING', `state_change.to === "TRANSCRIBING" (got "${sc2.to}")`);
  console.log('');

  // ── 5. Reconnect for a clean IDLE session, send vad_misfire ─
  ws.close();

  await new Promise(r => setTimeout(r, 300)); // wait for server to clear session

  const ws2 = new WebSocket(WS_URL);
  await new Promise<void>((resolve, reject) => {
    ws2.once('open', resolve);
    ws2.once('error', reject);
  });

  const SESSION_ID_2 = uuidv4();
  ws2.send(JSON.stringify({
    type: 'session_init',
    session_id: SESSION_ID_2,
    audio_format: { sample_rate: 16000, channels: 1, bit_depth: 16, encoding: 'pcm_s16le' },
    client_capabilities: { supports_barge_in: true, vad_library: 'silero-v5', browser: 'smoke-client' },
  }));

  await waitForMessage(ws2, m => m.type === 'session_ack');

  // Send vad_misfire in IDLE — no state_change should be emitted
  ws2.send(JSON.stringify({ type: 'vad_misfire', session_id: SESSION_ID_2, timestamp_ms: Date.now() }));

  const noChange = await Promise.race([
    waitForMessage(ws2, m => m.type === 'state_change', 800)
      .then(() => false)   // state_change arrived — BAD
      .catch(() => true),  // timeout — GOOD (no change emitted)
  ]);
  assert(noChange === true, 'vad_misfire in IDLE emits no state_change');
  console.log('');

  ws2.close();

  // ── Summary ───────────────────────────────────────────────
  console.log(`─────────────────────────────────`);
  if (failed === 0) {
    console.log(`✅ All ${passed} smoke checks passed\n`);
    process.exit(0);
  } else {
    console.error(`❌ ${failed} check(s) failed, ${passed} passed\n`);
    process.exit(1);
  }
}

runSmoke().catch(err => {
  console.error(`\n💥 Smoke client crashed: ${(err as Error).message}\n`);
  process.exit(1);
});
