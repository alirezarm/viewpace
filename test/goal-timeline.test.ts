import { describe, expect, it } from 'vitest';
import { PROFILES } from '../src/content/controller';
import { makeBlocks } from '../src/content/goal/blocks';
import { GoalMap } from '../src/content/goal/goal-map';
import { goalTarget, pacingLevel } from '../src/content/goal/goal-pacing';
import { LEVELS, goalTimeline, segmentDetail } from '../src/content/goal/goal-timeline';
import type { TimedWord } from '../src/shared/types';

const pace = PROFILES.normal;
const rating = (relevance: number, attention = 3, topic = 't') => ({ topic, relevance, attention, reason: 'r' });

/** ~10 minutes of speech with a pause every 50 s (several blocks), captions ending at 600 s. */
const words: TimedWord[] = [];
for (let t = 1, i = 0; t < 600; t += 0.4, i++) {
  words.push({ t, w: `w${i}` });
  if (i % 120 === 119) t += 3;
}
const newMap = () => new GoalMap(makeBlocks(words, 600));

describe('Goal Mode timeline', () => {
  it('starts with every part unmapped and fills in as each block is rated', () => {
    const map = newMap();
    const n = map.blocks.length;
    expect(n).toBeGreaterThan(4);
    let tl = goalTimeline(map, pace, 600, 0, true);
    expect(tl.segments.map((s) => s.state)).toEqual(Array(n).fill('pending'));
    expect(tl.progress).toBe(0);

    map.setRating(2, rating(8, 8, 'Training setup'));
    tl = goalTimeline(map, pace, 600, 0, true);
    expect(tl.segments[2]).toMatchObject({ state: 'mapped', level: 0, topic: 'Training setup', rate: 1, label: 'Key part for your goal' });
    expect(tl.segments.filter((s) => s.state === 'pending')).toHaveLength(n - 1);
    expect(tl.progress).toBeCloseTo(1 / n);

    map.setRating(3, rating(1));
    expect(goalTimeline(map, pace, 600, 0, true).progress).toBeCloseTo(2 / n);
  });

  it('keeps unmapped parts distinct from mapped low-relevance parts', () => {
    const map = newMap();
    map.setRating(0, rating(0, 0)); // mapped, not relevant: the fastest pacing
    map.setFailed(1);
    const [low, failed, pending] = goalTimeline(map, pace, 600, 0, true).segments;
    expect(low).toMatchObject({ state: 'mapped', level: LEVELS - 1, rate: 2 });
    expect(failed).toEqual({ start: failed!.start, end: failed!.end, state: 'failed' });
    expect(pending).toEqual({ start: pending!.start, end: pending!.end, state: 'pending' });
    // Unmapped parts carry no pacing at all, so they can't be drawn as "fast".
    expect(failed!.level).toBeUndefined();
    expect(pending!.level).toBeUndefined();
  });

  it('encodes the resulting pacing: a higher level always means faster playback', () => {
    const samples = [rating(9, 9), rating(8, 2), rating(5), rating(3), rating(0)];
    const levels = samples.map((r) => pacingLevel(r));
    expect(levels).toEqual([0, 1, 2, 3, 4]);
    const rates = samples.map((r) => goalTarget(r, pace).rate);
    expect([...rates].sort((a, b) => a - b)).toEqual(rates);
  });

  it('covers the whole video: blocks end to end, then any stretch without captions', () => {
    const map = newMap();
    const tl = goalTimeline(map, pace, 720, 0, true);
    expect(tl.duration).toBe(720);
    expect(tl.segments[0]!.start).toBe(0);
    for (let i = 1; i < tl.segments.length; i++) expect(tl.segments[i]!.start).toBe(tl.segments[i - 1]!.end);
    expect(tl.segments.at(-1)).toEqual({ start: 600, end: 720, state: 'none' });
    // Unknown duration (e.g. metadata not loaded yet): fall back to the transcript's end.
    expect(goalTimeline(map, pace, Number.NaN, 0, true).duration).toBe(600);
    expect(goalTimeline(map, pace, Number.NaN, 0, true).segments.at(-1)!.state).toBe('pending');
  });

  it('tracks the playback position, clamped to the video', () => {
    const map = newMap();
    expect(goalTimeline(map, pace, 600, 123.4, true).position).toBe(123.4);
    expect(goalTimeline(map, pace, 600, 250, true).position).toBe(250);
    expect(goalTimeline(map, pace, 600, -5, true).position).toBe(0);
    expect(goalTimeline(map, pace, 600, 9999, true).position).toBe(600);
  });

  it('reports whether mapping is still running', () => {
    const map = newMap();
    expect(goalTimeline(map, pace, 600, 0, true).mapping).toBe(true);
    expect(goalTimeline(map, pace, 600, 0, false).mapping).toBe(false);
  });

  it('gives compact detail for a part: time, topic, meaning and speed', () => {
    expect(segmentDetail({ start: 1120, end: 1205, state: 'mapped', level: 1, label: 'Important for your goal', rate: 1.15, topic: 'Evaluation metrics' })).toBe(
      '18:40–20:05\nEvaluation metrics\nImportant for your goal\n1.15×',
    );
    expect(segmentDetail({ start: 3600, end: 3725, state: 'pending' })).toBe('1:00:00–1:02:05\nNot mapped yet: speed unchanged for now');
    expect(segmentDetail({ start: 0, end: 60, state: 'failed' })).toContain("Couldn't be mapped");
  });
});
