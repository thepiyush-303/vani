// ============================================================
// Captions — the two text channels either side of the orb.
//
// Each side is a scrollable transcript (TranscriptSide): the settled turns
// stack above as muted bubbles and fade out toward the top, while the live turn
// sits at the bottom, on the orb's centre line, rendered large. The user's
// words run right — toward the orb — in mono; the assistant's run away from it
// in a book serif. Reading direction is the direction the audio travels.
//
// Interim user captions rewrite themselves as Vosk revises, so mono keeps that
// legible instead of jumpy. The assistant's reveal is paced to the TTS audio
// (Fix #2) so the words land with the voice rather than dumping when the LLM
// finishes streaming.
// ============================================================

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { GroundingSource } from '../protocol.ts';

/** Reveal pacing (Fix #2). Each word waits clamp(bufferedAudioMs / wordsLeft),
 *  so the text lands about when the audio does; as the buffer drains the tail
 *  reveals at MIN_WORD_MS (no freeze). If no audio arrives within STALL_MS (TTS
 *  silent or failed), the reveal proceeds anyway at a steady readable pace. */
const MIN_WORD_MS = 55;
const MAX_WORD_MS = 420;
const STALL_MS = 1800;
const STALL_WORD_MS = 300;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// ── One scrollable side: settled turns above, the live turn at the bottom ────

interface TranscriptSideProps {
  variant: 'user' | 'assistant';
  label: string;
  /** Settled turns for this side, oldest first; capped by the caller. */
  history: string[];
  /** The in-progress turn — a <UserCaption> or <AssistantCaption>. */
  children: ReactNode;
}

export function TranscriptSide({ variant, label, history, children }: TranscriptSideProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the newest turn in view: the column snaps to the bottom whenever its
  // content grows — a new bubble, streaming tokens, or the word-by-word reveal
  // (Fix #3, "scroll back to the middle when new text appears"). Once growth
  // stops, the user is free to scroll up through the history.
  useEffect(() => {
    const el = scrollRef.current;
    const list = listRef.current;
    if (!el || !list) return;
    const ro = new ResizeObserver(() => {
      el.scrollTop = el.scrollHeight;
    });
    ro.observe(list);
    return () => ro.disconnect();
  }, []);

  return (
    <section className={`side side--${variant}`}>
      <p className="caption__label">{label}</p>
      <div className="side__scroll" ref={scrollRef}>
        <div className="side__list" ref={listRef}>
          {history.map((text, i) => (
            <p className="bubble" key={i}>
              {text}
            </p>
          ))}
          {children}
        </div>
      </div>
    </section>
  );
}

// ── The live user turn ───────────────────────────────────────

interface UserCaptionProps {
  text: string;
  /** Whisper has replaced the Vosk interims with the real transcript. */
  final: boolean;
  /** Shown when there is nothing to show — says what to do next. */
  placeholder: string;
}

export function UserCaption({ text, final, placeholder }: UserCaptionProps) {
  const words = text.trim().split(/\s+/).filter(Boolean);

  if (words.length === 0) {
    return <p className="caption__placeholder">{placeholder}</p>;
  }
  return (
    <p className={final ? 'caption__text is-final' : 'caption__text'}>
      {/* Keyed by position and content: a word Vosk revises becomes a new
          element and fades in again, while settled words stay put. */}
      {words.map((word, i) => (
        <span className="caption__word" key={`${i}:${word}`}>
          {word}
        </span>
      ))}
    </p>
  );
}

// ── The live assistant turn ──────────────────────────────────

interface AssistantCaptionProps {
  /** Everything received so far this turn; revealed progressively. */
  text: string;
  sources: GroundingSource[];
  /** True once the first TTS audio chunk of this reply has arrived. */
  audioStarted: boolean;
  /** Buffered TTS audio still ahead of the playback clock, in ms. */
  remainingMs: () => number;
}

/** Mount one of these per reply — App keys it on a reply counter, which is what
 *  resets the reveal between turns. */
export function AssistantCaption({ text, sources, audioStarted, remainingMs }: AssistantCaptionProps) {
  const words = useMemo(() => text.split(/\s+/).filter(Boolean), [text]);
  const [shown, setShown] = useState(0);
  const [stalled, setStalled] = useState(false);

  // Fallback: if no audio has started within STALL_MS, reveal anyway — TTS may
  // be silent or have failed, and the text should not sit frozen. Cancelled the
  // moment audio arrives (the effect re-runs and returns early).
  useEffect(() => {
    if (audioStarted) return;
    const timer = window.setTimeout(() => setStalled(true), STALL_MS);
    return () => window.clearTimeout(timer);
  }, [audioStarted]);

  useEffect(() => {
    if (shown >= words.length) return; // caught up
    if (!audioStarted && !stalled) return; // waiting for the first audio chunk

    // With audio: pace so the words left finish about when the buffered audio
    // does, re-reading the clock each word. Stalled: a steady readable pace.
    const remainingWords = words.length - shown;
    const perWord = audioStarted
      ? clamp(remainingMs() / remainingWords, MIN_WORD_MS, MAX_WORD_MS)
      : STALL_WORD_MS;
    const timer = window.setTimeout(() => setShown((n) => n + 1), perWord);
    return () => window.clearTimeout(timer);
  }, [shown, words.length, audioStarted, stalled, remainingMs]);

  const revealed = words.slice(0, shown).join(' ');
  const catchingUp = shown < words.length;

  if (revealed.length === 0) {
    return <p className="caption__placeholder" aria-hidden="true" />;
  }
  return (
    <>
      <p className="caption__text caption__text--spoken" aria-live="polite">
        {revealed}
        {catchingUp && <span className="caption__caret" aria-hidden="true" />}
      </p>
      {sources.length > 0 && (
        <ul className="sources">
          {sources.slice(0, 5).map((source) => (
            <li key={source.uri}>
              <a href={source.uri} target="_blank" rel="noopener noreferrer" title={source.uri}>
                {source.title || source.uri}
              </a>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
