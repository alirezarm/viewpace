import { describe, expect, it } from 'vitest';
import { computeFeatures } from '../src/content/features';
import type { TimedWord } from '../src/shared/types';

const evenly = (from: number, to: number, n: number): TimedWord[] =>
  Array.from({ length: n }, (_, i) => ({ t: from + ((to - from) * i) / n, w: `w${i}` }));

describe('computeFeatures', () => {
  it('measures speech rate over continuous speech without pauses', () => {
    const words = evenly(0, 20, 50); // 150 wpm, 0.4 s apart
    const f = computeFeatures(words, [], 0, 20, 'word');
    expect(f.words).toBe(50);
    expect(f.wpm).toBeCloseTo(150);
    expect(f.pauseCount).toBe(0);
    expect(f.pauseSec).toBe(0);
  });

  it('detects a pause between two bursts of speech', () => {
    const words = [...evenly(0, 8, 20), ...evenly(12, 20, 20)]; // 4 s gap
    const f = computeFeatures(words, [], 0, 20, 'word');
    expect(f.pauseCount).toBe(1);
    expect(f.pauseSec).toBeCloseTo(4.4 - 0.4, 5); // onset gap minus a typical word
    expect(f.articulationWpm).toBeGreaterThan(f.wpm);
  });

  it('treats an empty window as all pause', () => {
    const f = computeFeatures([], [{ start: 0, end: 20, text: '[Music]' }], 0, 20, 'word');
    expect(f.words).toBe(0);
    expect(f.pauseRatio).toBe(1);
    expect(f.nonSpeechTags).toBe(1);
  });

  it('counts a leading silence before speech starts', () => {
    const f = computeFeatures(evenly(5, 20, 30), [], 0, 20, 'word');
    expect(f.pauseCount).toBe(1);
    expect(f.pauseSec).toBeCloseTo(5);
  });
});
