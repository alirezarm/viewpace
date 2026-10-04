import { describe, expect, it } from 'vitest';
import { CONTROL, PROFILES, computeTarget, initialState, step, videoMean } from '../src/content/controller';
import { buildUserPrompt, parseComplexity } from '../src/shared/complexity-prompt';
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

  it('does not over-speed a fast talker who pauses a lot', () => {
    // 220 wpm while talking, 40% silence → 132 wpm overall
    const f = feat(132, { articulationWpm: 220, pauseRatio: 0.4, pauseSec: 8 });
    const t = computeTarget({ features: f, complexity: null }, 'normal', 'baseline');
    expect(t.rate).toBeCloseTo((250 / 220) * 1.2); // ≈1.36×, not 250/132 ≈ 1.9×
    expect(t.reason).toMatch(/40% pauses → \+20%/);
  });

  it('caps the pause bonus', () => {
    const f = feat(100, { articulationWpm: 200, pauseRatio: 0.9 });
    const t = computeTarget({ features: f, complexity: null }, 'normal', 'baseline');
    expect(t.rate).toBeCloseTo((250 / 200) * (1 + CONTROL.pauseBonusMax));
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

  it('AI mode judges complexity relative to the video average', () => {
    const f = feat(150);
    const baseline = computeTarget({ features: f, complexity: null }, 'normal', 'baseline').rate;
    // A uniformly "hard" video (avg 0.7): an average chunk plays at Baseline speed...
    expect(computeTarget({ features: f, complexity: 0.7, complexityMean: 0.7 }, 'normal', 'ai').rate).toBeCloseTo(baseline);
    // ...and only chunks harder/easier than that average move the speed.
    expect(computeTarget({ features: f, complexity: 0.9, complexityMean: 0.7 }, 'normal', 'ai').rate).toBeLessThan(baseline);
    expect(computeTarget({ features: f, complexity: 0.5, complexityMean: 0.7 }, 'normal', 'ai').rate).toBeGreaterThan(baseline);
  });

  it('caps the AI effect at ±aiWeight', () => {
    const f = feat(150);
    const t = computeTarget({ features: f, complexity: 1, complexityMean: 0 }, 'normal', 'ai');
    expect(t.reason).toContain(`×${(1 - CONTROL.aiWeight).toFixed(2)}`);
  });

  it('baseline mode ignores the AI score', () => {
    const f = feat(150);
    expect(computeTarget({ features: f, complexity: 1 }, 'normal', 'baseline').rate).toBe(
      computeTarget({ features: f, complexity: 0 }, 'normal', 'baseline').rate,
    );
  });
});

describe('videoMean', () => {
  it('starts at the prior and moves toward real scores as chunks accumulate', () => {
    expect(videoMean([])).toBe(CONTROL.aiPriorMean);
    const one = videoMean([0.8]);
    const many = videoMean(Array(12).fill(0.8));
    expect(one).toBeGreaterThan(0.5);
    expect(one).toBeLessThan(0.65); // one chunk can't swing it far
    expect(many).toBeGreaterThan(0.73); // after 12 chunks the real scores dominate
  });

  it('becomes a moving average that follows a video getting harder', () => {
    const scores = [...Array(30).fill(0.4), ...Array(20).fill(0.8)];
    expect(videoMean(scores)).toBeGreaterThan(0.7); // a lifetime average would be 0.56
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

  it('never changes speed more often than every 7 s, whatever the target does', () => {
    let s = initialState(1.3);
    const changes: number[] = [];
    for (let t = 0; t < 120000; t += 1000) {
      const noisy = 1.3 + (t % 2000 === 0 ? 0.3 : -0.3);
      const r = step(s, noisy, t);
      s = r.state;
      if (r.decision?.changed) changes.push(t);
    }
    for (let i = 1; i < changes.length; i++) expect(changes[i]! - changes[i - 1]!).toBeGreaterThanOrEqual(CONTROL.minIntervalMs);
  });

  it('ignores small flip-flops of the target (e.g. AI scores alternating between chunks)', () => {
    let s = step(initialState(1.3), 1.45, 0).state; // one real change up to 1.45
    let changes = 0;
    for (let t = 1000; t < 60000; t += 1000) {
      const target = Math.floor(t / 10000) % 2 === 0 ? 1.45 : 1.3; // alternates every 10 s
      const r = step(s, target, t);
      s = r.state;
      if (r.decision?.changed) changes++;
    }
    expect(changes).toBeLessThanOrEqual(1);
  });

  it('slows down in bigger steps than it speeds up', () => {
    const down = step(initialState(2.0), 1.2, 0).decision!;
    const up = step(initialState(1.2), 2.0, 0).decision!;
    expect(down.rate).toBe(1.5); // −0.5
    expect(up.rate).toBe(1.45); // +0.25
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

describe('buildUserPrompt', () => {
  it('puts title and previous text before the excerpt, marked as context', () => {
    const p = buildUserPrompt('the excerpt', { title: 'Neural nets', previous: 'earlier words' });
    expect(p.indexOf('Video title: Neural nets')).toBeLessThan(p.indexOf('Previous text (context only'));
    expect(p.indexOf('earlier words')).toBeLessThan(p.indexOf('Excerpt to score'));
    expect(p.trim().endsWith('the excerpt\n"""')).toBe(true);
  });
  it('omits empty context', () => {
    expect(buildUserPrompt('x', { title: '', previous: '  ' })).toBe('Excerpt to score:\n"""\nx\n"""');
  });
});
