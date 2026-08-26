/**
 * client.js — Phase 2: Client VAD & Audio Capture
 *
 * Responsibilities:
 *   1. Connect to WS on ws://localhost:8765
 *   2. Send session_init handshake
 *   3. Initialize Silero VAD (@ricky0123/vad-web) with PRD §2.2 parameters
 *   4. On speech events: stream 16kHz Int16 PCM binary frames to server
 *   5. Handle all server→client messages (state_change, transcript_*, tts_interrupted, etc.)
 *
 * Audio format (PRD §2.1):
 *   16kHz, mono, 16-bit signed PCM, 512-sample chunks = 1024 bytes/frame
 *
 * VAD parameters (PRD §2.2):
 *   frameSamples=512, positiveSpeechThreshold=0.50, negativeSpeechThreshold=0.35
 *   minSpeechFrames=3, preSpeechPadFrames=5, redemptionFrames=8
 */

// ── Config ────────────────────────────────────────────────────────────────────

const WS_URL      = 'ws://localhost:8765';
const SAMPLE_RATE = 16000;          // PRD §2.1: exactly 16kHz
const FRAME_SIZE  = 512;            // PRD §2.1 / §2.2: 512 samples = 32ms @ 16kHz
const SESSION_ID  = crypto.randomUUID();

// ── PRD §2.2 Silero VAD parameters ────────────────────────────────────────────

const VAD_CONFIG = {
  frameSamples:              512,   // must match 16kHz frame size
  positiveSpeechThreshold:   0.60,  // was 0.50 — higher onset confidence; rejects noise/transients
  negativeSpeechThreshold:   0.35,  // silence threshold (unchanged — avoid clipping soft trailing speech)
  minSpeechFrames:           6,     // was 3 — require ~192ms of sustained speech; drops brief noise bursts
  preSpeechPadFrames:        5,     // 160ms pre-buffer (streaming onset handled by preBuffer, below)
  redemptionFrames:          4,     // 128ms silence window before speech_end (reduced for speed)
};

// ── State ─────────────────────────────────────────────────────────────────────

let ws            = null;          // WebSocket instance
let vad           = null;          // MicVAD instance
let isSpeaking    = false;         // true while VAD reports active speech
let serverState   = 'DISCONNECTED';
let speechStartTs = 0;             // epoch ms when current utterance started

// Rolling pre-buffer of recent mic frames captured while idle. Because minSpeechFrames
// is raised for noise rejection, the VAD only fires speech_start after ~192ms of
// confirmed speech; we flush this buffer at speech_start so the onset (the first word,
// spoken just before the trigger) isn't clipped from what the STT actually receives.
let preBuffer = [];
const PRE_BUFFER_FRAMES = 16;      // ~512ms of pre-roll at 32ms/frame

// ── DOM refs ──────────────────────────────────────────────────────────────────

const dot          = document.getElementById('status-dot');
const stateLabel   = document.getElementById('state-label');
const vadMeter     = document.getElementById('vad-meter');
const transcriptEl = document.getElementById('transcript');
const aiResponseEl = document.getElementById('ai-response');
const btnConnect   = document.getElementById('btn-connect');
const btnDisconnect= document.getElementById('btn-disconnect');
const logEl        = document.getElementById('log');

// ── UI helpers ────────────────────────────────────────────────────────────────

function setUIState(state) {
  serverState = state;
  stateLabel.textContent = state;

  dot.className = 'dot';
  if (state === 'LISTENING')            dot.classList.add('listening');
  else if (state === 'DISCONNECTED' || state === 'IDLE') dot.classList.add('idle');
  else                                  dot.classList.add('active');
}

function log(msg, type = 'sys') {
  const entry = document.createElement('div');
  entry.className = `entry ${type}`;
  const ts = new Date().toISOString().substring(11, 23);
  entry.textContent = `[${ts}] ${msg}`;
  logEl.appendChild(entry);
  logEl.scrollTop = logEl.scrollHeight;
}

function setTranscript(text, isFinal = false) {
  if (!text) {
    transcriptEl.innerHTML = '<span class="partial">…</span>';
    return;
  }
  
  if (isFinal) {
    transcriptEl.innerHTML = '';
    const span = document.createElement('span');
    span.className = 'final';
    span.textContent = text;
    transcriptEl.appendChild(span);
    return;
  }

  // Prevent re-animating words that were already present in previous partials
  const existingWords = Array.from(transcriptEl.querySelectorAll('.word')).map(el => el.textContent.trim());
  const newWords = text.trim().split(/\s+/).filter(Boolean);
  
  transcriptEl.innerHTML = '';
  newWords.forEach((word, i) => {
    const span = document.createElement('span');
    span.className = 'word';
    span.textContent = (i === 0 ? '' : ' ') + word;
    
    // Only animate if this word is NEW (index > existing length, or word changed)
    if (i >= existingWords.length || word !== existingWords[i]) {
      span.style.animationDelay = '0ms';
    } else {
      span.style.opacity = '1';
      span.style.animation = 'none';
      span.style.transform = 'none';
    }
    
    transcriptEl.appendChild(span);
  });
}

// ── AI Response Pacing ────────────────────────────────────────────────────────

let aiCursor = null;  // the blinking cursor element
let aiTokenQueue = [];
let aiTokenPacer = null;

function clearAiResponse() {
  aiResponseEl.innerHTML = '';
  aiCursor = null;
  aiTokenQueue = [];
  if (aiTokenPacer) {
    clearInterval(aiTokenPacer);
    aiTokenPacer = null;
  }
}

function appendAiToken(token) {
  aiTokenQueue.push(token);
  if (!aiTokenPacer) {
    // Pace tokens at ~40ms each so it looks natural even if Groq sends them in 1ms
    aiTokenPacer = setInterval(() => {
      const nextToken = aiTokenQueue.shift();
      if (nextToken !== undefined) {
        realAppendAiToken(nextToken);
      } else {
        clearInterval(aiTokenPacer);
        aiTokenPacer = null;
      }
    }, 45); 
  }
}

function realAppendAiToken(token) {
  const placeholder = aiResponseEl.querySelector('.placeholder');
  if (placeholder) placeholder.remove();

  if (aiCursor && aiCursor.parentNode) aiCursor.remove();

  const span = document.createElement('span');
  span.className = 'ai-token';
  span.textContent = token;
  aiResponseEl.appendChild(span);

  aiCursor = document.createElement('span');
  aiCursor.className = 'ai-cursor';
  aiResponseEl.appendChild(aiCursor);
}

function finalizeAiResponse() {
  // Wait for the visual queue to finish draining before removing the cursor
  const checkDone = setInterval(() => {
    if (aiTokenQueue.length === 0) {
      if (aiCursor && aiCursor.parentNode) aiCursor.remove();
      aiCursor = null;
      clearInterval(checkDone);
    }
  }, 100);
}

function setMeter(probability) {
  vadMeter.style.width = `${Math.min(Math.round(probability * 100), 100)}%`;
}

// ── Float32 → Int16 PCM conversion ───────────────────────────────────────────
// PRD §2.1: client must send raw 16-bit signed integer PCM (L16).
// @ricky0123/vad-web outputs Float32 frames already at 16kHz.

function float32ToInt16(float32Array) {
  const int16 = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const clamped = Math.max(-1, Math.min(1, float32Array[i]));
    int16[i] = clamped < 0
      ? Math.round(clamped * 32768)
      : Math.round(clamped * 32767);
  }
  return int16;
}

// ── WebSocket helpers ─────────────────────────────────────────────────────────

function sendJson(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
    log(`→ ${msg.type}`, 'out');
  }
}

function sendBinary(int16Array) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(int16Array.buffer);
  }
}

// ── TTS Audio Playback context ────────────────────────────────────────────────
// PRD §2.4 NOTE: use a SEPARATE AudioContext at 22050Hz for TTS playback.
// PRD §5.2 barge-in: suspend → clear queue → resume.

let playbackCtx   = null;   // AudioContext at 22050Hz
let playbackQueue = [];     // queued AudioBufferSourceNode list
let playbackTime  = 0;      // scheduler time for the next queued chunk

// ── Half-duplex mic gating ────────────────────────────────────────────────────
// While the assistant's TTS is playing, ignore the mic so it can't hear and
// transcribe its own voice — that self-echo caused an endless self-reply loop.
// Server state is useless for this: the server returns to IDLE the instant the
// LLM finishes, seconds before playback ends. So we gate off the Web Audio
// playback clock (playbackTime), which knows exactly when audio will finish.

let assistantSpeaking = false;  // true while TTS audio is playing/scheduled
let unmuteTimer       = null;   // fires once playback (+ echo tail) has finished
const ECHO_TAIL_MS    = 300;    // keep the mic gated briefly after audio for room-echo decay

function markAssistantSpeaking() {
  assistantSpeaking = true;
  const ctx = getPlaybackCtx();
  // Every new chunk extends playbackTime; reschedule the un-mute for the tail.
  const remainingMs = Math.max(0, (playbackTime - ctx.currentTime) * 1000) + ECHO_TAIL_MS;
  if (unmuteTimer) clearTimeout(unmuteTimer);
  unmuteTimer = setTimeout(() => {
    assistantSpeaking = false;
    unmuteTimer = null;
    preBuffer = [];
    log('🎙 mic live (assistant finished speaking)', 'sys');
  }, remainingMs);
}

// True whenever the mic must be ignored: while the assistant's audio is playing
// (assistantSpeaking) OR any time the server is mid-turn (TRANSCRIBING, LLM_STREAMING,
// TTS_STREAMING, etc.). The mic is live ONLY when idle or actively listening to the
// user. This is full half-duplex: background noise during the assistant's turn can no
// longer trigger a false new turn or a false barge-in. (Real barge-in is Phase 6.)
function micGated() {
  return assistantSpeaking || (serverState !== 'IDLE' && serverState !== 'LISTENING');
}

function getPlaybackCtx() {
  if (!playbackCtx || playbackCtx.state === 'closed') {
    playbackCtx = new AudioContext({ sampleRate: 22050 });
    playbackTime = 0;
  }
  return playbackCtx;
}

function enqueueTtsChunk(arrayBuffer) {
  const ctx    = getPlaybackCtx();
  const raw    = new Int16Array(arrayBuffer.slice(4)); // strip 4-byte framing header
  const float  = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) float[i] = raw[i] / 32768;

  const audioBuf = ctx.createBuffer(1, float.length, 22050);
  audioBuf.getChannelData(0).set(float);

  const source = ctx.createBufferSource();
  source.buffer = audioBuf;
  source.connect(ctx.destination);

  const startAt = Math.max(ctx.currentTime, playbackTime);
  source.start(startAt);
  playbackTime = startAt + audioBuf.duration;
  playbackQueue.push(source);

  markAssistantSpeaking();  // gate the mic for the duration of this (and any queued) audio
}

function flushTtsPlayback() {
  // PRD §5.2: barge-in — suspend → clear all queued nodes → resume
  if (playbackCtx) {
    playbackCtx.suspend().then(() => {
      for (const src of playbackQueue) {
        try { src.stop(0); src.disconnect(); } catch (_) { /* already stopped */ }
      }
      playbackQueue = [];
      playbackTime  = 0;
      playbackCtx.resume();
    });
  }
  if (unmuteTimer) { clearTimeout(unmuteTimer); unmuteTimer = null; }
  assistantSpeaking = false;  // audio stopped early — mic goes live again
  log('⚡ TTS flushed (barge-in)', 'sys');
}

// ── Server→client message handler ────────────────────────────────────────────

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'session_ack':
      setUIState(msg.state);
      log(`✓ session_ack — state=${msg.state} tts_rate=${msg.tts_sample_rate}Hz`, 'in');
      break;

    case 'state_change':
      setUIState(msg.to);
      log(`↻ ${msg.from} → ${msg.to}`, 'in');
      break;

    case 'transcript_partial':
      setTranscript(`[partial] ${msg.text}`, false);
      log(`✎ partial: "${msg.text}"`, 'in');
      break;

    case 'transcript_final':
      setTranscript(msg.text, true);
      log(`✎ final: "${msg.text}" (${msg.duration_ms}ms)`, 'in');
      // Clear AI box for fresh response
      clearAiResponse();
      break;

    case 'llm_token':
      appendAiToken(msg.delta);
      break;

    case 'tool_call':
      log(`🔧 tool_call: ${msg.tool_name}`, 'in');
      break;

    case 'tts_interrupted':
      flushTtsPlayback();
      break;

    case 'turn_complete':
      log(`✓ turn_complete (${msg.total_latency_ms}ms, ${msg.token_count} tokens)`, 'in');
      finalizeAiResponse();
      setUIState('IDLE');
      break;

    case 'error':
      log(`✗ error [${msg.code}]: ${msg.message}`, 'err');
      if (!msg.recoverable) disconnect();
      break;

    default:
      log(`? unknown: ${msg.type}`, 'sys');
  }
}

// ── WebSocket binary frame handler ────────────────────────────────────────────
// PRD §3.3.2: TTS audio chunks are binary ArrayBuffers with a 4-byte framing
// header [0xAF][0xFE][uint16_LE sequence] before raw PCM bytes.

function handleBinaryFrame(data) {
  // Minimal check: at least 4 bytes header + some audio
  if (data.byteLength <= 4) return;
  const header = new Uint8Array(data, 0, 2);
  if (header[0] === 0xAF && header[1] === 0xFE) {
    enqueueTtsChunk(data);
  }
}

// ── VAD initialization ────────────────────────────────────────────────────────

async function initVAD() {
  log('Initializing Silero VAD…', 'sys');

  vad = await window.vad.MicVAD.new({
    ...VAD_CONFIG,
    // Browser-level DSP applied at getUserMedia, before the VAD or STT ever see the
    // audio. noiseSuppression is the big lever for continuous fan/room/crowd noise;
    // echoCancellation additionally suppresses any residual of the assistant's own
    // playback; autoGainControl normalizes mic level so soft speech still clears the
    // threshold. These stack with the client-side half-duplex gating below.
    additionalAudioConstraints: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl:  true,
    },
    modelURL:         '/vad/silero_vad.onnx',
    onnxWASMBasePath: '/vad/',
    ortConfig: (ort) => {
      ort.env.wasm.wasmPaths = '/vad/';
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
    },

    // PRD §2.2 onSpeechStart: send speech_start + begin PCM streaming
    onSpeechStart() {
      if (micGated()) return;   // half-duplex: only start a turn when idle/listening
      isSpeaking    = true;
      speechStartTs = Date.now();
      sendJson({ type: 'speech_start', session_id: SESSION_ID, timestamp_ms: speechStartTs });
      // Flush the pre-roll so the onset (buffered before the VAD trigger) isn't clipped.
      if (ws && ws.readyState === WebSocket.OPEN) {
        for (const f of preBuffer) sendBinary(float32ToInt16(f));
      }
      preBuffer = [];
      setMeter(1.0);
      log('🎤 speech_start', 'out');
    },

    // PRD §2.2 onFrameProcessed: send binary PCM if speech is active
    // frame.audio is Float32Array at 16kHz (FRAME_SIZE = 512 samples)
    onFrameProcessed(probabilities, frame) {
      setMeter(probabilities.isSpeech);
      if (micGated()) return;   // ignore the mic during the assistant's turn / playback

      if (isSpeaking) {
        if (ws && ws.readyState === WebSocket.OPEN) sendBinary(float32ToInt16(frame));
      } else {
        // Not speaking yet — keep a short rolling pre-roll so the onset isn't lost
        // when the (raised) minSpeechFrames threshold finally fires speech_start.
        preBuffer.push(frame);
        if (preBuffer.length > PRE_BUFFER_FRAMES) preBuffer.shift();
      }
    },

    // PRD §2.2 onSpeechEnd: send speech_end + stop PCM streaming
    onSpeechEnd() {
      if (micGated() || !isSpeaking) return;   // only end a turn we actually started
      const duration = Date.now() - speechStartTs;
      isSpeaking = false;
      setMeter(0);
      sendJson({ type: 'speech_end', session_id: SESSION_ID, duration_ms: duration,
                 timestamp_ms: Date.now() });
    },

    // PRD §2.2 onVADMisfire: discard, server resets to IDLE
    onVADMisfire() {
      if (micGated()) return;   // noise/echo during the assistant's turn — ignore
      isSpeaking = false;
      preBuffer = [];
      setMeter(0);
      sendJson({ type: 'vad_misfire', session_id: SESSION_ID, timestamp_ms: Date.now() });
      log('↩ vad_misfire', 'out');
    },
  });

  log('VAD ready ✓', 'sys');
}

// ── Connect / Disconnect ──────────────────────────────────────────────────────

async function connect() {
  btnConnect.disabled    = true;
  btnDisconnect.disabled = false;
  setUIState('Connecting…');
  log(`Connecting to ${WS_URL}`, 'sys');

  try {
    ws = new WebSocket(WS_URL);
    ws.binaryType = 'arraybuffer';  // PRD §2.1: receive TTS binary as ArrayBuffer

    ws.onopen = async () => {
      log('WS connected', 'sys');

      // PRD §3.3.1 session_init — sent once immediately on connection
      const initMsg = {
        type: 'session_init',
        session_id: SESSION_ID,
        audio_format: { sample_rate: SAMPLE_RATE, channels: 1, bit_depth: 16, encoding: 'pcm_s16le' },
        client_capabilities: { supports_barge_in: true, vad_library: 'silero-v5', browser: navigator.userAgent.slice(0, 60) },
      };
      ws.send(JSON.stringify(initMsg));
      log('→ session_init', 'out');

      // Initialize and start VAD after WS is ready
      await initVAD();
      vad.start();
      log('VAD started — speak to begin 🎙', 'sys');
    };

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        handleBinaryFrame(event.data);
      } else {
        try {
          handleServerMessage(JSON.parse(event.data));
        } catch {
          log(`✗ unparseable message: ${String(event.data).slice(0, 80)}`, 'err');
        }
      }
    };

    ws.onclose = (event) => {
      log(`WS closed (${event.code})`, 'sys');
      cleanup();
    };

    ws.onerror = () => {
      log('WS error — check server is running on port 8765', 'err');
      cleanup();
    };

  } catch (err) {
    log(`Failed to connect: ${err.message}`, 'err');
    cleanup();
  }
}

function disconnect() {
  if (vad) { vad.pause(); vad = null; }
  if (ws)  { ws.close(); ws = null; }
  cleanup();
}

function cleanup() {
  isSpeaking = false;
  assistantSpeaking = false;
  preBuffer = [];
  if (unmuteTimer) { clearTimeout(unmuteTimer); unmuteTimer = null; }
  setMeter(0);
  setUIState('DISCONNECTED');
  setTranscript('Waiting for speech…', false);
  btnConnect.disabled    = false;
  btnDisconnect.disabled = true;
}

// ── Button event listeners ────────────────────────────────────────────────────

btnConnect.addEventListener('click', connect);
btnDisconnect.addEventListener('click', disconnect);
