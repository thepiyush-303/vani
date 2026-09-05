// ============================================================
// useVadMic — microphone capture and voice-activity detection.
//
// Ported from the prototype's client.js: the Silero thresholds, the
// Float32→Int16 conversion, the 512-sample framing and the onset pre-buffer
// are the tuned values from that file and should not be changed casually.
//
// One thing is deliberately different: this hook owns the MediaStream instead
// of letting the library create it, so that muting can stop the tracks
// outright. Muting has to mean no audio enters the app at all — not a flag
// that drops frames after the fact.
// ============================================================

import { useEffect, useRef } from 'react';
import { FRAME_SIZE, type ClientMessage, type LogKind } from '../protocol.ts';
import type { MicVadInstance, VadProbabilities } from '../vad.d.ts';

// PRD §2.2 Silero parameters, as tuned in the prototype.
const VAD_CONFIG = {
  frameSamples: FRAME_SIZE, // 512 samples = 32ms @ 16kHz
  positiveSpeechThreshold: 0.6, // high onset confidence; rejects noise and transients
  negativeSpeechThreshold: 0.35, // silence threshold; low enough not to clip soft trailing speech
  minSpeechFrames: 6, // ~192ms of sustained speech before a turn starts
  preSpeechPadFrames: 5,
  redemptionFrames: 4, // 128ms of silence before speech_end
};

// The worklet and the Silero weights are fetched from here. This is the
// version we vendored into client/public/vad, pinned so the two cannot drift.
// MicVAD has no option for pointing at individual files — to run without any
// network at all, download vad.worklet.bundle.min.js and
// silero_vad_legacy.onnx from this URL into client/public/vad/ and change
// this to '/vad/'. The onnxruntime .wasm files are already served locally.
const VAD_ASSET_PATH = 'https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.22/dist/';

// ~512ms of pre-roll at 32ms/frame. minSpeechFrames is raised for noise
// rejection, so the VAD only fires after ~192ms of confirmed speech; flushing
// this buffer at speech_start keeps the first word from being clipped off what
// the STT actually receives.
const PRE_BUFFER_FRAMES = 16;

/** PRD §2.1 — the wire format is raw 16-bit signed PCM. */
function float32ToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const clamped = Math.max(-1, Math.min(1, input[i]));
    out[i] = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
  }
  return out;
}

/** Frame loudness as a 0..1 value for the orb. Root-mean-square, then a
 *  square-root curve so ordinary speech uses the middle of the range instead
 *  of hugging the bottom of it. */
function frameLevel(frame: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  const rms = Math.sqrt(sum / frame.length);
  return Math.min(1, Math.sqrt(rms) * 2.2);
}

interface Options {
  /** Capture only while this is true: connected and unmuted. */
  active: boolean;
  /** Read fresh inside VAD callbacks: true while the mic must be ignored. */
  gatedRef: React.RefObject<boolean>;
  sessionIdRef: React.RefObject<string>;
  sendJson: (msg: ClientMessage) => void;
  sendPcm: (pcm: Int16Array) => void;
  log: (text: string, kind?: LogKind) => void;
}

export function useVadMic({ active, gatedRef, sessionIdRef, sendJson, sendPcm, log }: Options) {
  /** Latest mic loudness, 0..1. A ref, not state: this updates ~31×/second. */
  const micLevelRef = useRef(0);

  useEffect(() => {
    if (!active) {
      micLevelRef.current = 0;
      return;
    }

    let cancelled = false;
    let stream: MediaStream | null = null;
    let vad: MicVadInstance | null = null;

    // Per-utterance state, kept in the closure so the VAD callbacks below see
    // the same values without re-running this effect.
    let speaking = false;
    let speechStartTs = 0;
    let preBuffer: Float32Array[] = [];

    const teardown = () => {
      vad?.destroy();
      vad = null;
      // We created the stream, so we are the ones who must stop it. This is
      // what turns the browser's recording indicator off.
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
      preBuffer = [];
      micLevelRef.current = 0;
    };

    void (async () => {
      if (!window.vad) {
        log('voice detection library did not load — reload the page', 'err');
        return;
      }
      try {
        // Browser-level DSP, applied before the VAD or the STT sees anything.
        // noiseSuppression is the lever for continuous room noise;
        // echoCancellation suppresses residual of our own playback (D7);
        // autoGainControl keeps soft speech above the threshold.
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        });
        if (cancelled) return teardown();

        vad = await window.vad.MicVAD.new({
          ...VAD_CONFIG,
          stream,
          baseAssetPath: VAD_ASSET_PATH,
          onnxWASMBasePath: '/vad/',
          ortConfig: (ort) => {
            ort.env.wasm.wasmPaths = '/vad/';
            ort.env.wasm.numThreads = 1;
            ort.env.wasm.proxy = false;
          },

          onSpeechStart: () => {
            if (gatedRef.current) return;
            speaking = true;
            speechStartTs = Date.now();
            sendJson({ type: 'speech_start', session_id: sessionIdRef.current, timestamp_ms: speechStartTs });
            // Flush the pre-roll so the onset isn't lost.
            for (const frame of preBuffer) sendPcm(float32ToInt16(frame));
            preBuffer = [];
          },

          onFrameProcessed: (_probabilities: VadProbabilities, frame: Float32Array) => {
            if (gatedRef.current) {
              micLevelRef.current = 0;
              return;
            }
            micLevelRef.current = frameLevel(frame);
            if (speaking) {
              sendPcm(float32ToInt16(frame));
            } else {
              preBuffer.push(frame);
              if (preBuffer.length > PRE_BUFFER_FRAMES) preBuffer.shift();
            }
          },

          onSpeechEnd: () => {
            if (gatedRef.current || !speaking) return; // only end a turn we started
            speaking = false;
            sendJson({
              type: 'speech_end',
              session_id: sessionIdRef.current,
              duration_ms: Date.now() - speechStartTs,
              timestamp_ms: Date.now(),
            });
          },

          onVADMisfire: () => {
            if (gatedRef.current) return;
            speaking = false;
            preBuffer = [];
            sendJson({ type: 'vad_misfire', session_id: sessionIdRef.current, timestamp_ms: Date.now() });
          },
        });

        if (cancelled) return teardown();
        vad.start();
        log('mic open', 'sys');
      } catch (err) {
        teardown();
        const reason = err instanceof Error ? err.message : String(err);
        log(`could not open the mic: ${reason}`, 'err');
      }
    })();

    return () => {
      cancelled = true;
      teardown();
      log('mic closed', 'sys');
    };
  }, [active, gatedRef, sessionIdRef, sendJson, sendPcm, log]);

  return micLevelRef;
}
