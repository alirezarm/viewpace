import { describe, expect, it } from 'vitest';
import { PROFILES } from '../src/content/controller';
import { makeBlocks } from '../src/content/goal/blocks';
import { GoalMap } from '../src/content/goal/goal-map';
import { goalTarget, pacingLevel } from '../src/content/goal/goal-pacing';
import { LEVELS, goalTimeline, seekFromKey, seekFromPointer, seekTimeAt, segmentTooltip } from '../src/content/goal/goal-timeline';
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

  it('hover card: time range, the block topic as the main line, then meaning and speed', () => {
    expect(segmentTooltip({ start: 802, end: 845, state: 'mapped', level: 0, label: 'Key part for your goal', rate: 1, topic: 'Analyzing the network' })).toEqual({
      range: '13:22–14:05',
      topic: 'Analyzing the network',
      detail: 'Key part for your goal · 1×',
    });
    expect(segmentTooltip({ start: 1120, end: 1205, state: 'mapped', level: 1, label: 'Important for your goal', rate: 1.15, topic: 'Evaluation metrics' })).toEqual({
      range: '18:40–20:05',
      topic: 'Evaluation metrics',
      detail: 'Important for your goal · 1.15×',
    });
  });

  it('hover card shows the topic as soon as that block is rated, from the block itself (no sections)', () => {
    const map = newMap();
    const card = (i: number) => segmentTooltip(goalTimeline(map, pace, 600, 0, true).segments[i]!);
    expect(card(2)).toMatchObject({ topic: null, detail: 'Not analyzed yet' });
    map.setRating(2, rating(5, 3, 'Cost function setup'));
    expect(card(2)).toMatchObject({ topic: 'Cost function setup', detail: 'Relevant background · 1.4×' });
    expect(map.sections()).toEqual([]); // no section grouping has happened
  });

  it('hover card leaves out a missing topic instead of showing an empty or undefined line', () => {
    for (const topic of [undefined, '', '   ']) {
      const t = segmentTooltip({ start: 0, end: 60, state: 'mapped', level: 4, label: 'Not relevant to your goal', rate: 2, topic });
      expect(t).toEqual({ range: '0:00–1:00', topic: null, detail: 'Not relevant to your goal · 2×' });
    }
  });

  it('hover card says only "Not analyzed yet" for unmapped parts, inventing no topic or relevance', () => {
    expect(segmentTooltip({ start: 3600, end: 3725, state: 'pending' })).toEqual({ range: '1:00:00–1:02:05', topic: null, detail: 'Not analyzed yet' });
    expect(segmentTooltip({ start: 0, end: 60, state: 'failed' })).toEqual({ range: '0:00–1:00', topic: null, detail: "Couldn't be analyzed" });
    expect(segmentTooltip({ start: 600, end: 720, state: 'none' })).toEqual({ range: '10:00–12:00', topic: null, detail: 'No captions' });
  });
});

describe('Goal Map navigation', () => {
  const duration = 40 * 60; // a 40-minute video
  // The map as drawn: 272 px wide, starting 100 px from the left of the viewport.
  const click = (fraction: number) => seekFromPointer('click', 100 + fraction * 272, 100, 272, duration);

  it('seeks proportionally to where the map is clicked', () => {
    expect(click(0)).toBe(0);
    expect(click(0.5)).toBe(20 * 60);
    expect(click(0.25)).toBe(10 * 60);
    expect(click(0.999)).toBeCloseTo(duration * 0.999);
  });

  it('lands just before the end at the far right, so the video does not end', () => {
    expect(click(1)).toBe(duration - 0.5);
    expect(seekFromPointer('click', 9999, 100, 272, duration)).toBe(duration - 0.5); // beyond the edge
    expect(seekFromPointer('click', 0, 100, 272, duration)).toBe(0); // before the start
  });

  it('seeks the same way over mapped and unmapped parts (position alone decides)', () => {
    const map = newMap();
    map.setRating(1, rating(9, 9));
    const tl = goalTimeline(map, pace, 600, 0, true);
    const mapped = tl.segments[1]!;
    const unmapped = tl.segments[4]!;
    expect(unmapped.state).toBe('pending');
    const mid = (s: { start: number; end: number }) => (s.start + s.end) / 2;
    expect(seekTimeAt(mid(mapped) / 600, 600)).toBeCloseTo(mid(mapped));
    expect(seekTimeAt(mid(unmapped) / 600, 600)).toBeCloseTo(mid(unmapped));
  });

  it('never seeks on hover or pointer movement, only on click', () => {
    for (const type of ['mouseover', 'mousemove', 'mouseenter', 'pointermove', 'mousedown']) {
      expect(seekFromPointer(type, 236, 100, 272, duration)).toBeNull();
    }
    expect(seekFromPointer('click', 236, 100, 272, duration)).toBe(20 * 60);
  });

  it('supports the keyboard on the focused map', () => {
    expect(seekFromKey('ArrowRight', 600, duration)).toBe(610);
    expect(seekFromKey('ArrowLeft', 600, duration)).toBe(590);
    expect(seekFromKey('PageUp', 600, duration)).toBe(660);
    expect(seekFromKey('PageDown', 30, duration)).toBe(0); // clamped at the start
    expect(seekFromKey('Home', 600, duration)).toBe(0);
    expect(seekFromKey('End', 600, duration)).toBe(duration - 0.5);
    expect(seekFromKey('Enter', 600, duration)).toBeNull();
    expect(seekFromKey('a', 600, duration)).toBeNull();
  });

  it('does nothing harmful before the duration is known', () => {
    expect(seekTimeAt(0.5, Number.NaN)).toBe(0);
    expect(seekFromPointer('click', 236, 100, 0, duration)).toBeNull(); // map not laid out
  });
});
