// ============================================================
// Orb — the centre of the screen and the only thing that moves.
//
// A polar oscilloscope: a fixed hairline graticule with tick marks, and three
// live traces whose radius is modulated by a real waveform. Amplitude is the
// loudness of whoever is currently talking. At rest the traces settle to
// almost-circles with a slow drift — calm, but not dead.
//
// Colour identifies the speaker: the cold blue of the signal for the user, a
// deeper indigo for the assistant. Both stay in the blue family.
// ============================================================

import { useEffect, useRef } from 'react';
import type { LevelSource } from '../hooks/useOrbLevel.ts';

const TAU = Math.PI * 2;
const SEGMENTS = 240; // points per trace
const SWEEP_MS = 520; // the one-time draw-in on mount

// --signal and --signal-deep from index.css, as RGB so they can be mixed.
const USER_RGB = [79, 168, 255] as const;
const ASSISTANT_RGB = [107, 123, 255] as const;

// Per-trace look: base radius as a fraction of R, amplitude scale, alpha, width.
const TRACES = [
  { base: 0.58, amp: 1.15, alpha: 0.95, width: 1.4 },
  { base: 0.7, amp: 1.0, alpha: 0.5, width: 1.1 },
  { base: 0.82, amp: 0.8, alpha: 0.28, width: 1.1 },
] as const;

interface Props {
  /** Reads the current 0..1 loudness. Called once per animation frame. */
  readLevel: () => number;
  /** Who the loudness belongs to. 'none' holds the current colour. */
  source: LevelSource;
  /** Not connected: hold everything still and hold it back. */
  dim: boolean;
}

function rgba(mix: number, alpha: number): string {
  const r = Math.round(USER_RGB[0] + (ASSISTANT_RGB[0] - USER_RGB[0]) * mix);
  const g = Math.round(USER_RGB[1] + (ASSISTANT_RGB[1] - USER_RGB[1]) * mix);
  const b = Math.round(USER_RGB[2] + (ASSISTANT_RGB[2] - USER_RGB[2]) * mix);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function Orb({ readLevel, source, dim }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Props read inside the animation loop, which must not restart on re-render.
  const readLevelRef = useRef(readLevel);
  const sourceRef = useRef(source);
  const dimRef = useRef(dim);
  useEffect(() => {
    readLevelRef.current = readLevel;
    sourceRef.current = source;
    dimRef.current = dim;
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let width = 0;
    let height = 0;
    let dpr = 1;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = Math.round(rect.width * dpr);
      height = Math.round(rect.height * dpr);
      canvas.width = width;
      canvas.height = height;
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    let raf = 0;
    const startedAt = performance.now();
    let hueMix = 0;

    const drawGraticule = (cx: number, cy: number, R: number, sweep: number, alpha: number) => {
      const from = -Math.PI / 2;
      ctx.strokeStyle = `rgba(120, 150, 200, ${0.16 * alpha})`;
      ctx.lineWidth = dpr;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 0.97, from, from + TAU * sweep);
      ctx.stroke();

      // 72 ticks, every 5°; the four cardinals are longer. Ticks are the
      // instrument's fixed reference — they never move, which is what makes
      // the trace read as a live signal.
      for (let i = 0; i < 72; i++) {
        const a = from + (i / 72) * TAU;
        if ((i / 72) > sweep) break;
        const cardinal = i % 18 === 0;
        const inner = R * (cardinal ? 0.93 : 0.97);
        const outer = R * (cardinal ? 1.03 : 1.0);
        ctx.strokeStyle = `rgba(120, 150, 200, ${(cardinal ? 0.32 : 0.14) * alpha})`;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
        ctx.lineTo(cx + Math.cos(a) * outer, cy + Math.sin(a) * outer);
        ctx.stroke();
      }

      ctx.fillStyle = `rgba(120, 150, 200, ${0.3 * alpha})`;
      ctx.beginPath();
      ctx.arc(cx, cy, 1.5 * dpr, 0, TAU);
      ctx.fill();
    };

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const elapsed = now - startedAt;
      const sweep = calm ? 1 : Math.min(1, elapsed / SWEEP_MS);
      const t = calm ? 0 : elapsed / 1000;

      const level = readLevelRef.current();
      const dimmed = dimRef.current;
      const fade = (dimmed ? 0.32 : 1) * sweep;

      // Ease toward the speaker's colour rather than cutting to it.
      const target = sourceRef.current === 'tts' ? 1 : sourceRef.current === 'mic' ? 0 : hueMix;
      hueMix += (target - hueMix) * 0.05;

      ctx.clearRect(0, 0, width, height);
      const cx = width / 2;
      const cy = height / 2;
      const R = Math.min(width, height) / 2 - 2 * dpr;

      drawGraticule(cx, cy, R, sweep, fade);

      const energy = dimmed ? 0 : level;

      for (let k = TRACES.length - 1; k >= 0; k--) {
        const spec = TRACES[k];
        const breathe = calm ? 1 : 1 + 0.012 * Math.sin(t * 0.55 + k * 1.4);
        const baseR = R * spec.base * breathe;
        const amp = R * (0.012 + 0.16 * energy) * spec.amp;
        const seed = k * 2.1;

        ctx.beginPath();
        for (let i = 0; i <= SEGMENTS; i++) {
          const a = (i / SEGMENTS) * TAU;
          // Three harmonics at unrelated frequencies, so the outline is wavy
          // rather than a rippling circle.
          const w =
            Math.sin(3 * a + t * 1.3 + seed) +
            0.6 * Math.sin(5 * a - t * 0.9 + seed * 1.7) +
            0.35 * Math.sin(8 * a + t * 1.7 + seed * 0.5);
          const r = baseR + amp * (w / 1.95);
          const x = cx + Math.cos(a) * r;
          const y = cy + Math.sin(a) * r;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();

        // The innermost trace gets a faint fill so the waveform has body, and
        // a little bloom when it is loud. Nothing else glows.
        if (k === 0) {
          ctx.fillStyle = rgba(hueMix, (0.05 + 0.06 * energy) * fade);
          ctx.fill();
          ctx.shadowColor = rgba(hueMix, 0.6);
          ctx.shadowBlur = 14 * energy * dpr;
        }
        ctx.strokeStyle = rgba(hueMix, spec.alpha * fade);
        ctx.lineWidth = spec.width * dpr;
        ctx.stroke();
        ctx.shadowBlur = 0;
      }
    };

    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, []);

  return <canvas ref={canvasRef} className="orb" aria-hidden="true" />;
}
