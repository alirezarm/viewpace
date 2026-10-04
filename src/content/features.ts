import type { Cue, SpeechFeatures, TimedWord } from '../shared/types';
import { isNonSpeech } from './captions';

/** Gap between consecutive word onsets that counts as a pause (seconds). */
export const PAUSE_ONSET_GAP = 1.0;
/** Typical duration of one spoken word; subtracted from an onset gap to estimate silence. */
export const TYPICAL_WORD_SEC = 0.4;

/** Index of the first word with t >= time (words sorted by t). */
export function lowerBound(words: TimedWord[], time: number): number {
  let lo = 0;
  let hi = words.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (words[mid]!.t < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function wordsInRange(words: TimedWord[], from: number, to: number): TimedWord[] {
  return words.slice(lowerBound(words, from), lowerBound(words, to));
}

export function cuesInRange(cues: Cue[], from: number, to: number): Cue[] {
  return cues.filter((c) => c.end > from && c.start < to);
}

/**
 * Deterministic speech features for [from, to) on the media timeline.
 *
 * Pauses are inferred from gaps between word onsets (including the window edges). With
 * word-level ASR timing this approximates real silence; with cue-level timing (uploaded
 * captions) words are spread evenly inside each cue, so only gaps *between* cues register.
 */
export function computeFeatures(
  words: TimedWord[],
  cues: Cue[],
  from: number,
  to: number,
  timing: SpeechFeatures['timing'],
): SpeechFeatures {
  const windowSec = Math.max(0.001, to - from);
  const inRange = wordsInRange(words, from, to);

  let pauseCount = 0;
  let pauseSec = 0;
  const onsets = [from, ...inRange.map((w) => w.t), to];
  for (let i = 1; i < onsets.length; i++) {
    // The trailing edge gap is measured from the last onset, so it already includes that word.
    const gap = onsets[i]! - onsets[i - 1]!;
    const isLeading = i === 1;
    const threshold = isLeading ? PAUSE_ONSET_GAP - TYPICAL_WORD_SEC : PAUSE_ONSET_GAP;
    if (gap >= threshold) {
      pauseCount++;
      pauseSec += isLeading ? gap : gap - TYPICAL_WORD_SEC;
    }
  }
  pauseSec = Math.min(pauseSec, windowSec);
  const speechSec = Math.max(0.001, windowSec - pauseSec);

  const nonSpeechTags = cuesInRange(cues, from, to).reduce(
    (n, c) => n + (c.text.match(/\[[^\]]*\]|♪/g) ?? []).filter(isNonSpeech).length,
    0,
  );

  return {
    windowStart: from,
    windowSec,
    words: inRange.length,
    wpm: (inRange.length / windowSec) * 60,
    articulationWpm: inRange.length > 0 ? (inRange.length / speechSec) * 60 : 0,
    pauseCount,
    pauseSec,
    pauseRatio: pauseSec / windowSec,
    nonSpeechTags,
    timing,
  };
}

export function windowText(words: TimedWord[], from: number, to: number): string {
  return wordsInRange(words, from, to)
    .map((w) => w.w)
    .join(' ');
}
