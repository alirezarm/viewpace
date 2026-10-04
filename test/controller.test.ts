import { describe, expect, it } from 'vitest';
import { CONTROL, PROFILES, computeTarget, initialState, step } from '../src/content/controller';
import { parseComplexity } from '../src/shared/complexity-prompt';
import type { SpeechFeatures } from '../src/shared/types';

const feat = (wpm: number, extra: Partial<SpeechFeatures> = {}): SpeechFeatures => ({
  windowStart: 0,
  windowSec: 20,
  words: Math.round((wpm * 20) / 60),
  wpm,
  articulationWpm: wpm,
  pauseCount: 0,
  pauseSec: 0,
  pauseRatio: 0,
  nonSpeechTags: 0,
  timing: 'word',
  ...extra,
});

describe('computeTarget', () => {
  it('speeds slow speech up and leaves fast speech near 1×', () => {
    const slow = computeTarget({ features: feat(125), complexity: null }, 'normal', 'baseline');
    const fast = computeTarget({ features: feat(240), complexity: null }, 'normal', 'baseline');
    expect(slow.rate).toBeCloseTo(PROFILES.normal.targetWpm / 125);
    expect(fast.rate).toBeLessThan(1.1);
  });

  it('respects profile clamps', () => {
    expect(computeTarget({ features: feat(60), complexity: null }, 'relaxed', 'baseline').rate).toBe(PROFILES.relaxed.maxRate);
    expect(computeTarget({ features: feat(400), complexity: null }, 'fast', 'baseline').rate).toBe(PROFILES.fast.minRate);
  });

  it('falls back to the profile default with too few words', () => {
    const t = computeTarget({ features: feat(10, { words: 3, nonSpeechTags: 2 }), complexity: null }, 'normal', 'baseline');
    expect(t.rate).toBe(PROFILES.normal.defaultRate);
    expect(t.reason).toMatch(/music/);
  });

  it('AI mode slows down for complex content and speeds up for simple content', () => {
    const f = feat(150);
    const base = computeTarget({ features: f, complexity: null }, 'normal', 'ai').rate;
    const hard = computeTarget({ features: f, complexity: 0.9 }, 'normal', 'ai').rate;
    const easy = computeTarget({ features: f, complexity: 0.1 }, 'normal', 'ai').rate;
    expect(hard).toBeLessThan(base);
    expect(easy).toBeGreaterThan(base);
  });

  it('baseline mode ignores the AI score', () => {
    const f = feat(150);
    expect(computeTarget({ features: f, complexity: 1 }, 'normal', 'baseline').rate).toBe(
      computeTarget({ features: f, complexity: 0 }, 'normal', 'baseline').rate,
    );
  });
});

describe('step', () => {
  it('decides immediately the first time, then no more often than every 7 s', () => {
    let s = initialState(1);
    let r = step(s, 1.5, 0);
    expect(r.decision?.changed).toBe(true);
    expect(r.decision?.rate).toBe(1.25); // max step 0.25
    s = r.state;
    for (let t = 1000; t < CONTROL.minIntervalMs; t += 1000) {
      r = step(s, 2.0, t);
      expect(r.decision).toBeNull();
      s = r.state;
    }
    r = step(s, 2.0, CONTROL.minIntervalMs);
    expect(r.decision?.changed).toBe(true);
  });

  it('holds when the target is within hysteresis', () => {
    const r = step(initialState(1.3), 1.36, 0);
    expect(r.decision).toMatchObject({ changed: false, rate: 1.3 });
  });

  it('requires a bigger difference to reverse direction shortly after a change', () => {
    let s = step(initialState(1), 1.2, 0).state; // up to 1.2
    expect(s.current).toBe(1.2);
    // target drops by 0.15: above hysteresis but below the reversal threshold
    for (let t = 1000; t <= 7000; t += 1000) s = step(s, 1.05, t).state;
    expect(s.current).toBe(1.2);
  });

  it('never oscillates faster than the decision interval under a noisy target', () => {
    let s = initialState(1.3);
    const changes: number[] = [];
    for (let t = 0; t < 120000; t += 1000) {
      const noisy = 1.3 + (t % 2000 === 0 ? 0.3 : -0.3);
      const r = step(s, noisy, t);
      s = r.state;
      if (r.decision?.changed) changes.push(t);
    }
    for (let i = 1; i < changes.length; i++) expect(changes[i]! - changes[i - 1]!).toBeGreaterThanOrEqual(CONTROL.minIntervalMs);
    expect(changes.length).toBeLessThan(4); // EMA averages the noise out
  });
});

describe('parseComplexity', () => {
  it('clamps and normalizes', () => {
    expect(parseComplexity('{"complexity": 7, "reason": "dense"}')).toEqual({ raw: 7, score: 0.7, label: 'dense' });
    expect(parseComplexity('{"complexity": 14, "reason": ""}').raw).toBe(10);
  });
  it('throws on garbage', () => {
    expect(() => parseComplexity('{"complexity": "lots"}')).toThrow();
  });
});
