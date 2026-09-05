// ============================================================
// useAudioPlayback — schedules the TTS audio the server streams back.
//
// Ported from the prototype's client.js: a dedicated 22050Hz AudioContext
// (Piper's rate), chunks scheduled back-to-back on the Web Audio clock rather
// than played on arrival, and the barge-in flush (suspend → drop queue →
// resume).
//
// `speaking` comes from that same clock, not from the server's state. The
// server leaves TTS_STREAMING as soon as it has written the last chunk, which
// can be seconds before the user stops hearing it; anything that depends on
// "is the assistant still talking" — mic gating, the orb — has to use the
// clock instead.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { TTS_SAMPLE_RATE, type LogKind } from '../protocol.ts';

/** Keep the mic gated a moment past the audio itself, for room echo to decay. */
const ECHO_TAIL_MS = 300;

export function useAudioPlayback(log: (text: string, kind?: LogKind) => void) {
  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const queueRef = useRef<AudioBufferSourceNode[]>([]);
  const nextStartRef = useRef(0);
  const tailTimerRef = useRef<number | null>(null);
  const [speaking, setSpeaking] = useState(false);

  const logRef = useRef(log);
  useEffect(() => {
    logRef.current = log;
  });

  const context = useCallback(() => {
    let ctx = ctxRef.current;
    if (!ctx || ctx.state === 'closed') {
      ctx = new AudioContext({ sampleRate: TTS_SAMPLE_RATE });
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.connect(ctx.destination);
      ctxRef.current = ctx;
      analyserRef.current = analyser;
      nextStartRef.current = 0;
    }
    return ctx;
  }, []);

  /** PRD §3.3.2 — binary frames are [0xAF][0xFE][uint16 LE seq] then raw PCM. */
  const enqueue = useCallback(
    (frame: ArrayBuffer) => {
      if (frame.byteLength <= 4) return;
      const header = new Uint8Array(frame, 0, 2);
      if (header[0] !== 0xaf || header[1] !== 0xfe) return;

      const ctx = context();
      // The context is created after the user has clicked Connect, so it is
      // allowed to run — but resume defensively rather than play silence.
      if (ctx.state === 'suspended') void ctx.resume();

      const pcm = new Int16Array(frame.slice(4));
      const samples = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 32768;

      const buffer = ctx.createBuffer(1, samples.length, TTS_SAMPLE_RATE);
      buffer.getChannelData(0).set(samples);

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(analyserRef.current!);

      const startAt = Math.max(ctx.currentTime, nextStartRef.current);
      source.start(startAt);
      nextStartRef.current = startAt + buffer.duration;
      queueRef.current.push(source);

      // Every new chunk pushes the end of playback further out, so the
      // "finished speaking" moment is rescheduled each time.
      setSpeaking(true);
      const tailMs = Math.max(0, (nextStartRef.current - ctx.currentTime) * 1000) + ECHO_TAIL_MS;
      if (tailTimerRef.current !== null) window.clearTimeout(tailTimerRef.current);
      tailTimerRef.current = window.setTimeout(() => {
        tailTimerRef.current = null;
        queueRef.current = [];
        setSpeaking(false);
        logRef.current('mic live — assistant finished speaking', 'sys');
      }, tailMs);
    },
    [context],
  );

  /** Buffered audio still ahead of the playback clock, in ms — how much sound
   *  is scheduled but not yet heard. The caption reveal paces itself to this so
   *  the words track Piper's voice instead of racing the LLM's token burst. */
  const remainingMs = useCallback(() => {
    const ctx = ctxRef.current;
    if (!ctx) return 0;
    return Math.max(0, (nextStartRef.current - ctx.currentTime) * 1000);
  }, []);

  /** PRD §5.2 barge-in: stop everything already scheduled, immediately. */
  const flush = useCallback(() => {
    const ctx = ctxRef.current;
    if (ctx) {
      void ctx.suspend().then(() => {
        for (const source of queueRef.current) {
          try {
            source.stop(0);
            source.disconnect();
          } catch {
            /* already finished */
          }
        }
        queueRef.current = [];
        nextStartRef.current = 0;
        void ctx.resume();
      });
    }
    if (tailTimerRef.current !== null) {
      window.clearTimeout(tailTimerRef.current);
      tailTimerRef.current = null;
    }
    setSpeaking(false);
  }, []);

  useEffect(() => {
    return () => {
      if (tailTimerRef.current !== null) window.clearTimeout(tailTimerRef.current);
      void ctxRef.current?.close();
      ctxRef.current = null;
      analyserRef.current = null;
      queueRef.current = [];
    };
  }, []);

  return { enqueue, flush, remainingMs, speaking, analyserRef };
}
