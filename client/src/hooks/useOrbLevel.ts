// ============================================================
// useOrbLevel — one loudness number for the orb to draw.
//
// The orb has a single amplitude input, and whoever is talking owns it: the
// mic while the user speaks, the TTS playback while the assistant answers.
// Both sources are real audio — nothing here is on a timer.
//
// This returns a function rather than state on purpose. The value changes
// every frame, so the caller reads it inside its own requestAnimationFrame
// loop; putting it in state would re-render the tree 60 times a second.
// ============================================================

import { useCallback, useRef } from 'react';

export type LevelSource = 'mic' | 'tts' | 'none';

// Rise fast so a syllable registers; fall slowly so the orb settles instead of
// flickering between words.
const ATTACK = 0.35;
const DECAY = 0.08;

export function useOrbLevel(
  micLevelRef: React.RefObject<number>,
  ttsAnalyserRef: React.RefObject<AnalyserNode | null>,
  source: LevelSource,
) {
  const smoothedRef = useRef(0);
  const scratchRef = useRef<Uint8Array<ArrayBuffer> | null>(null);

  return useCallback(() => {
    let target = 0;

    if (source === 'mic') {
      target = micLevelRef.current;
    } else if (source === 'tts') {
      const analyser = ttsAnalyserRef.current;
      if (analyser) {
        let scratch = scratchRef.current;
        if (!scratch || scratch.length !== analyser.fftSize) {
          scratch = new Uint8Array(new ArrayBuffer(analyser.fftSize));
          scratchRef.current = scratch;
        }
        analyser.getByteTimeDomainData(scratch);
        let sum = 0;
        for (let i = 0; i < scratch.length; i++) {
          const sample = (scratch[i] - 128) / 128;
          sum += sample * sample;
        }
        // Same curve as the mic path so the two sources feel comparable.
        target = Math.min(1, Math.sqrt(Math.sqrt(sum / scratch.length)) * 2.2);
      }
    }

    const smoothed = smoothedRef.current;
    smoothedRef.current = smoothed + (target - smoothed) * (target > smoothed ? ATTACK : DECAY);
    return smoothedRef.current;
  }, [micLevelRef, ttsAnalyserRef, source]);
}
