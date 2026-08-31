/**
 * client.js — v2.0: Porcupine Wake Word + Silero VAD + Grounding Attribution
 *
 * Responsibilities:
 *   1. Boot in ASLEEP state — Porcupine polls mic for "Hey Porcupine" wake word
 *   2. On wake: open WebSocket, play chime, init Silero VAD → LISTENING
 *   3. Stream 16kHz Int16 PCM binary frames via WebSocket
 *   4. Handle server→client messages (state_change, transcript_*, tts_interrupted,
 *      grounding_sources, turn_complete, etc.)
 *   5. Auto-return to ASLEEP after 30s inactivity post turn_complete
 *
 * Phase 8 (Wake Word): requires /porcupine/index.min.js and PICOVOICE_ACCESS_KEY in index.html
 * Phase 9 (Grounding): grounding_sources rendered as a clickable sources panel
 */

// ── Config ────────────────────────────────────────────────────────────────────

const WS_URL      = 'ws://localhost:8765';
const SAMPLE_RATE = 16000;          // PRD §2.1: exactly 16kHz
const FRAME_SIZE  = 512;            // PRD §2.1 / §2.2: 512 samples = 32ms @ 16kHz
const SESSION_ID  = crypto.randomUUID();

// v2.0 Phase 8: Picovoice key injected by server into the <meta> tag at serve time.
// Falls back gracefully to null if not configured (manual connect button shown).
const PICOVOICE_KEY = document.getElementById('pv-key')?.content || null;
const INACTIVITY_MS = 30_000; // return to ASLEEP 30s after turn_complete

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
let porcupine     = null;          // v2.0: PorcupineWorker instance
let clientState   = 'ASLEEP';      // v2.0: ASLEEP | WAKING | IDLE | ... (mirrors server states)
let inactivityTimer = null;        // v2.0: auto-sleep timer
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

const dot           = document.getElementById('status-dot');
const stateLabel    = document.getElementById('state-label');
const vadMeter      = document.getElementById('vad-meter');
const transcriptEl  = document.getElementById('transcript');
const aiResponseEl  = document.getElementById('ai-response');
const btnConnect    = document.getElementById('btn-connect');
const btnDisconnect = document.getElementById('btn-disconnect');
const logEl         = document.getElementById('log');
const wakeBadge     = document.getElementById('wake-badge');       // v2.0 Phase 8
const groundingPanel= document.getElementById('grounding-panel'); // v2.0 Phase 9
const groundingLinks= document.getElementById('grounding-links'); // v2.0 Phase 9

// ── UI helpers ────────────────────────────────────────────────────────────────

function setUIState(state) {
  serverState = state;
  stateLabel.textContent = state;

  dot.className = 'dot';
  if (state === 'ASLEEP')                                    dot.classList.add('asleep');
  else if (state === 'WAKING')                               dot.classList.add('waking');
  else if (state === 'LISTENING')                            dot.classList.add('listening');
  else if (state === 'DISCONNECTED' || state === 'IDLE')     dot.classList.add('idle');
  else                                                        dot.classList.add('active');

  // Show wake badge only in ASLEEP state
  if (wakeBadge) wakeBadge.style.display = (state === 'ASLEEP') ? 'block' : 'none';
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
      // v2.0 Phase 8: start inactivity timer — go back to ASLEEP if user doesn't speak within 30s
      startInactivityTimer();
      break;

    case 'grounding_sources': {
      // v2.0 Phase 9: render source attribution panel (never spoken)
      if (!groundingPanel || !groundingLinks) break;
      if (!msg.sources || msg.sources.length === 0) {
        groundingPanel.style.display = 'none';
        break;
      }
      groundingLinks.innerHTML = '';
      msg.sources.slice(0, 5).forEach(src => {
        const a = document.createElement('a');
        a.href    = src.uri;
        a.target  = '_blank';
        a.rel     = 'noopener noreferrer';
        a.title   = src.uri;
        a.textContent = src.title || src.uri;
        groundingLinks.appendChild(a);
      });
      groundingPanel.style.display = 'block';
      log(`🔍 grounding: ${msg.sources.length} source(s)`, 'in');
      break;
    }

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
      // v2.0 Phase 8: cancel inactivity timer — user is actively speaking
      if (inactivityTimer) { clearTimeout(inactivityTimer); inactivityTimer = null; }
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

// ── v2.0 Phase 8: Porcupine Wake Word ─────────────────────────────────────────

/**
 * Plays a brief two-note ascending chime (880Hz → 1046Hz) via the Web Audio API.
 * Uses the TTS playback context (22050Hz) — called before VAD initializes.
 * PRD_v2.md §A.5
 */
function playListeningChime() {
  const ctx    = getPlaybackCtx();
  const notes  = [880, 1046.5];
  let startAt  = ctx.currentTime + 0.05; // slight delay so mic unmutes first

  for (const freq of notes) {
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type   = 'sine';
    osc.frequency.setValueAtTime(freq, startAt);
    gain.gain.setValueAtTime(0, startAt);
    gain.gain.linearRampToValueAtTime(0.35, startAt + 0.02);       // 20ms attack
    gain.gain.exponentialRampToValueAtTime(0.001, startAt + 0.15); // 130ms decay
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(startAt);
    osc.stop(startAt + 0.15);
    startAt += 0.12; // 120ms gap between notes
  }
}

/**
 * Called when Porcupine detects the wake word.
 * Opens the WebSocket and starts the active listening flow.
 */
async function transitionToWaking() {
  if (clientState === 'WAKING' || clientState === 'IDLE') return; // guard
  clientState = 'WAKING';
  setUIState('WAKING');
  log('🔔 Wake word detected — activating…', 'sys');

  // 1. Pause Porcupine to free the mic worklet
  if (porcupine) {
    try { porcupine.pause(); } catch(_) {}
  }

  // 2. Play the ascending chime (Web Audio — no network)
  playListeningChime();

  // 3. Open WebSocket
  ws = new WebSocket(WS_URL);
  ws.binaryType = 'arraybuffer';

  ws.onopen = async () => {
    log('WS connected', 'sys');

    // 4. Send session_init
    const initMsg = {
      type: 'session_init',
      session_id: SESSION_ID,
      audio_format: { sample_rate: SAMPLE_RATE, channels: 1, bit_depth: 16, encoding: 'pcm_s16le' },
      client_capabilities: { supports_barge_in: true, vad_library: 'silero-v5', browser: navigator.userAgent.slice(0, 60) },
    };
    ws.send(JSON.stringify(initMsg));
    log('→ session_init', 'out');

    // 5. Send wake_word_detected (PRD_v2.md §A.7 — for server logging only)
    ws.send(JSON.stringify({
      type: 'wake_word_detected',
      session_id: SESSION_ID,
      keyword: 'porcupine',
      confidence: 1.0, // Porcupine doesn't expose a confidence score; always 1.0
      timestamp_ms: Date.now(),
    }));

    // 6. Init and start Silero VAD
    await initVAD();
    vad.start();
    clientState = 'IDLE';
    setUIState('IDLE');
    log('VAD started — speak your command 🎙', 'sys');
  };

  ws.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) {
      handleBinaryFrame(event.data);
    } else {
      try {
        handleServerMessage(JSON.parse(event.data));
      } catch {
        log(`✗ unparseable: ${String(event.data).slice(0, 80)}`, 'err');
      }
    }
  };

  ws.onclose = (event) => {
    log(`WS closed (${event.code})`, 'sys');
    // If closed unexpectedly (not by us), revert to ASLEEP
    if (clientState !== 'ASLEEP') {
      cleanupToAsleep();
    }
  };

  ws.onerror = () => {
    log('WS error — check server is running on port 8765', 'err');
    cleanupToAsleep();
  };
}

/**
 * Internal: tears down VAD + WS and goes fully back to ASLEEP,
 * then resumes Porcupine keyword listening.
 */
function cleanupToAsleep() {
  if (vad)  { try { vad.pause();  } catch(_) {} vad = null; }
  if (ws)   { try { ws.close();   } catch(_) {} ws  = null; }
  isSpeaking      = false;
  assistantSpeaking = false;
  preBuffer       = [];
  if (unmuteTimer)    { clearTimeout(unmuteTimer); unmuteTimer = null; }
  if (inactivityTimer){ clearTimeout(inactivityTimer); inactivityTimer = null; }
  if (groundingPanel) groundingPanel.style.display = 'none';
  setMeter(0);
  clientState = 'ASLEEP';
  setUIState('ASLEEP');
  setTranscript('Waiting for wake word…', false);
  // Resume Porcupine
  if (porcupine) {
    try { porcupine.resume(); } catch(_) {}
    log('💤 Asleep — say "Hey Porcupine" to wake', 'sys');
  }
}

/**
 * Starts the 30-second inactivity timer.
 * If the user doesn't speak again after turn_complete, returns to ASLEEP.
 * The timer is cleared on any new speech_start.
 */
function startInactivityTimer() {
  if (inactivityTimer) clearTimeout(inactivityTimer);
  inactivityTimer = setTimeout(() => {
    inactivityTimer = null;
    log('💤 Inactivity timeout — returning to ASLEEP', 'sys');
    cleanupToAsleep();
  }, INACTIVITY_MS);
}

/**
 * Initializes Porcupine using the built-in "Porcupine" keyword.
 * If the access key is missing or the SDK is not loaded, falls back to
 * showing the manual Connect button.
 */
async function initPorcupine() {
  // Check if SDK loaded (script tag present) and key configured
  const hasSdk = typeof window.PorcupineWeb !== 'undefined';
  const hasKey = PICOVOICE_KEY && PICOVOICE_KEY !== '__PICOVOICE_KEY_PLACEHOLDER__';

  if (!hasSdk || !hasKey) {
    // Graceful fallback: show manual connect button
    log(
      hasKey
        ? '⚠ Porcupine SDK not loaded — using manual connect'
        : '⚠ PICOVOICE_ACCESS_KEY not set — using manual connect',
      'sys'
    );
    setUIState('DISCONNECTED');
    setTranscript('Waiting for speech…', false);
    btnConnect.style.display    = '';
    btnDisconnect.style.display = '';
    return;
  }

  // Hide manual buttons — wake word manages the connection lifecycle
  btnConnect.style.display    = 'none';
  btnDisconnect.style.display = 'none';

  setUIState('ASLEEP');
  setTranscript('Say "Hey Porcupine" to start…', false);

  try {
    // Use the built-in "Porcupine" keyword (available without a custom .ppn file)
    porcupine = await window.PorcupineWeb.PorcupineWorker.create(
      PICOVOICE_KEY,
      { label: 'Porcupine', builtin: 'Porcupine' }, // built-in keyword
      (detection) => {
        // Callback fires when wake word is detected
        if (detection?.label === 'Porcupine' && clientState === 'ASLEEP') {
          transitionToWaking();
        }
      },
      { publicPath: '/porcupine/porcupine_params.pv' }
    );
    await porcupine.start();
    log('🌙 Porcupine active — say "Hey Porcupine" to wake', 'sys');
  } catch (err) {
    console.error('[porcupine] init failed:', err);
    log(`⚠ Porcupine init failed: ${err.message} — using manual connect`, 'err');
    porcupine = null;
    setUIState('DISCONNECTED');
    btnConnect.style.display    = '';
    btnDisconnect.style.display = '';
  }
}

// ── Page auto-boot ────────────────────────────────────────────────────────────
// v2.0: Page loads in ASLEEP state. Porcupine initializes immediately.
// If Porcupine is unavailable (no key/SDK), falls back to manual connect button.

initPorcupine();

// Cancel inactivity timer on any VAD speech_start — user is speaking again
const _origOnSpeechStart = VAD_CONFIG;
// The VAD's onSpeechStart is defined inside initVAD();
// we hook the inactivity cancellation there instead (see initVAD's onSpeechStart).
