import { beforeEach, describe, expect, it } from 'vitest';
import {
  UsageMeter,
  addStats,
  analysisOf,
  emptyCounters,
  emptyStats,
  loadStats,
  summarize,
  type UsageStats,
} from '../src/shared/stats';
import type { DecisionLogEntry, Feedback } from '../src/shared/types';

const entry = (feedback: Feedback | null, mode: 'baseline' | 'ai' = 'baseline', aiScore: number | null = null): DecisionLogEntry => ({
  id: Math.random().toString(36), timestamp: 1, videoId: 'v', videoTime: 0, chunk: '', features: null,
  aiScore, aiLabel: null, aiMean: null, previousRate: 1, selectedRate: 1.5, targetRate: 1.5, changed: true,
  mode, profile: 'normal', reason: '', transcriptSource: '', feedback, feedbackAt: feedback ? 2 : null,
});

describe('analysisOf', () => {
  it('counts content analysis only when an AI score was actually used', () => {
    expect(analysisOf({ mode: 'ai', aiScore: 7 })).toBe('content');
    expect(analysisOf({ mode: 'ai', aiScore: null })).toBe('speech'); // AI mode, score not ready
    expect(analysisOf({ mode: 'baseline', aiScore: null })).toBe('speech');
  });
});

describe('summarize: feedback', () => {
  it('computes shares over rated entries only, split by analysis', () => {
    const log = [
      entry('good'), entry('good'), entry('too_fast'), entry(null), // speech; one unrated decision
      entry('good', 'ai', 6), entry('too_slow', 'ai', 8),
      entry('too_fast', 'ai', null), // AI mode without a score: speech
    ];
    const s = summarize(log, null);
    expect(s.total.feedback).toBe(6);
    expect(s.byAnalysis.speech.feedback).toBe(4);
    expect(s.byAnalysis.speech.justRight).toBeCloseTo(2 / 4);
    expect(s.byAnalysis.speech.tooFast).toBeCloseTo(2 / 4);
    expect(s.byAnalysis.content.feedback).toBe(2);
    expect(s.byAnalysis.content.tooSlow).toBeCloseTo(1 / 2);
  });

  it('reports no shares (not 0%) without feedback', () => {
    const s = summarize([], null);
    expect(s.total.justRight).toBeNull();
    expect(s.byAnalysis.content.tooFast).toBeNull();
  });
});

describe('summarize: usage counters', () => {
  const stats: UsageStats = {
    since: 1000,
    byAnalysis: {
      speech: { playSec: 600, rateSec: 900, videos: 4, overrides: 3, temporary: 1 },
      content: { playSec: 30, rateSec: 45, videos: 1, overrides: 0, temporary: 0 },
    },
  };

  it('gives a time-weighted average speed, only with enough playback', () => {
    const s = summarize([], stats);
    expect(s.byAnalysis.speech.avgSpeed).toBeCloseTo(1.5);
    expect(s.byAnalysis.content.avgSpeed).toBeNull(); // 30 s < minimum
    expect(s.total.avgSpeed).toBeCloseTo(945 / 630);
    expect(s.total.playMinutes).toBeCloseTo(10.5);
  });

  it('counts lasting overrides per adapted video, excluding temporary ones', () => {
    const s = summarize([], stats);
    expect(s.byAnalysis.speech.overrides).toBe(2);
    expect(s.byAnalysis.speech.overridesPerVideo).toBeCloseTo(0.5);
    expect(s.byAnalysis.content.overridesPerVideo).toBe(0);
    expect(s.total.overrides).toBe(2);
    expect(s.since).toBe(1000);
  });

  it('has no override rate without adapted videos', () => {
    expect(summarize([], emptyStats(0)).total.overridesPerVideo).toBeNull();
  });
});

describe('UsageMeter', () => {
  it('counts playback time only while ViewPace is in control', () => {
    const m = new UsageMeter();
    m.tick(0, true, 1.5, 'speech'); // first tick only sets the clock
    m.tick(1000, true, 1.5, 'speech');
    m.tick(2000, false, 1.5, 'speech'); // not in control
    m.tick(3000, true, 2, 'content');
    const d = m.takeDelta()!;
    expect(d.speech.playSec).toBeCloseTo(1);
    expect(d.speech.rateSec).toBeCloseTo(1.5);
    expect(d.content.playSec).toBeCloseTo(1);
    expect(d.content.rateSec).toBeCloseTo(2);
  });

  it('caps gaps between ticks (throttled background tabs)', () => {
    const m = new UsageMeter();
    m.tick(0, true, 1, 'speech');
    m.tick(60_000, true, 1, 'speech');
    expect(m.takeDelta()!.speech.playSec).toBe(2);
  });

  it('resets after takeDelta and returns null when nothing happened', () => {
    const m = new UsageMeter();
    m.override('speech');
    expect(m.takeDelta()!.speech.overrides).toBe(1);
    expect(m.takeDelta()).toBeNull();
  });
});

describe('stored counters', () => {
  beforeEach(() => {
    const mem: Record<string, unknown> = {};
    (globalThis as { chrome?: unknown }).chrome = {
      storage: { local: { get: async (k: string) => ({ [k]: mem[k] }), set: async (o: object) => Object.assign(mem, o), remove: async () => {} } },
    };
  });

  it('accumulate into one fixed-size record', async () => {
    const d = { speech: { ...emptyCounters(), playSec: 10, videos: 1 }, content: emptyCounters() };
    await addStats(d, 500);
    await addStats(d, 900);
    const s = (await loadStats())!;
    expect(s.since).toBe(500);
    expect(s.byAnalysis.speech.playSec).toBe(20);
    expect(s.byAnalysis.speech.videos).toBe(2);
    expect(Object.keys(s.byAnalysis)).toEqual(['speech', 'content']);
  });
});
