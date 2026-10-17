import { describe, expect, it } from 'vitest';
import { PROFILES } from '../src/content/controller';
import { makeBlocks } from '../src/content/goal/blocks';
import { GoalMap } from '../src/content/goal/goal-map';
import { goalTarget, pacingLevel } from '../src/content/goal/goal-pacing';
import { LEVELS, goalTimeline, seekFromKey, seekFromPointer, seekTimeAt, mapStatus, readyThrough, mergeSegments, regionKey, regionLabelRequest, regionTooltip, visualTier, type TimelineSegment } from '../src/content/goal/goal-timeline';
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
    expect(tl.segments[2]).toMatchObject({ state: 'mapped', level: 0, topic: 'Training setup', rate: 1, label: 'Key' });
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

  /** A hover card for a single block, as the map shows it. */
  const card1 = (seg: Parameters<typeof mergeSegments>[0][number]) => regionTooltip(mergeSegments([seg])[0]!);

  it('hover card: time range, the block topic as the main line, then meaning and speed', () => {
    expect(card1({ start: 802, end: 845, state: 'mapped', level: 0, label: 'Key', rate: 1, topic: 'Analyzing the network' })).toEqual({
      range: '13:22–14:05',
      topics: ['Analyzing the network'],
      more: 0,
      detail: 'Key · 1×',
    });
  });

  it('hover card shows the topic as soon as that block is rated, from the block itself (no sections)', () => {
    const map = newMap();
    const regionAt = (t: number) => goalTimeline(map, pace, 600, 0, true).regions.find((r) => t >= r.start && t < r.end)!;
    const t = (map.blocks[2]!.start + map.blocks[2]!.end) / 2;
    expect(regionTooltip(regionAt(t))).toMatchObject({ topics: [], detail: 'Not analyzed yet' });
    map.setRating(2, rating(5, 3, 'Cost function setup'));
    expect(regionTooltip(regionAt(t))).toMatchObject({ topics: ['Cost function setup'], detail: 'Relevant · 1.4×' });
    expect(map.sections()).toEqual([]); // no section grouping has happened
  });

  it('hover card leaves out missing topics instead of showing empty or undefined lines', () => {
    for (const topic of [undefined, '', '   ']) {
      expect(card1({ start: 0, end: 60, state: 'mapped', level: 4, label: 'Not relevant', rate: 2, topic })).toEqual({
        range: '0:00–1:00',
        topics: [],
        more: 0,
        detail: 'Not relevant · 2×',
      });
    }
  });

  it('hover card says only "Not analyzed yet" for unmapped parts, inventing no topic or relevance', () => {
    expect(card1({ start: 3600, end: 3725, state: 'pending' })).toEqual({ range: '1:00:00–1:02:05', topics: [], more: 0, detail: 'Not analyzed yet' });
    expect(card1({ start: 0, end: 60, state: 'failed' })).toEqual({ range: '0:00–1:00', topics: [], more: 0, detail: "Couldn't be analyzed" });
    expect(card1({ start: 600, end: 720, state: 'none' })).toEqual({ range: '10:00–12:00', topics: [], more: 0, detail: 'No captions' });
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

describe('Goal Map regions (display aggregation)', () => {
  const LABEL = ['Key', 'Important', 'Relevant', 'Low relevance', 'Not relevant'];
  const RATE = [1, 1.15, 1.4, 1.75, 2];
  /** A mapped block starting at `start` (60 s long) in pacing row `level`. */
  const m = (start: number, level: number, topic?: string, len = 60): TimelineSegment => ({
    start,
    end: start + len,
    state: 'mapped',
    level,
    label: LABEL[level],
    rate: RATE[level],
    topic,
  });
  const p = (start: number): TimelineSegment => ({ start, end: start + 60, state: 'pending' });
  const f = (start: number): TimelineSegment => ({ start, end: start + 60, state: 'failed' });
  /** Consecutive mapped blocks from a list of pacing rows. */
  const rows = (levels: number[]) => levels.map((l, i) => m(i * 60, l));
  const shape = (rs: ReturnType<typeof mergeSegments>) => rs.map((r) => [r.start, r.end, r.state, r.tier ?? null, r.blocks]);

  it('draws the five speeds as three tiers: slow (1×, 1.15×), medium (1.4×), fast (1.75×, 2×)', () => {
    expect([0, 1, 2, 3, 4].map(visualTier)).toEqual([0, 0, 1, 2, 2]);
  });

  it('merges 1× and 1.15× neighbours into one slow region', () => {
    expect(shape(mergeSegments(rows([0, 1, 0, 1])))).toEqual([[0, 240, 'mapped', 0, 4]]);
  });

  it('merges 1.75× and 2× neighbours into one fast region', () => {
    expect(shape(mergeSegments(rows([3, 4, 4, 3])))).toEqual([[0, 240, 'mapped', 2, 4]]);
  });

  it('keeps slow, medium and fast runs apart', () => {
    expect(shape(mergeSegments(rows([0, 1, 2, 2, 3, 4])))).toEqual([
      [0, 120, 'mapped', 0, 2],
      [120, 240, 'mapped', 1, 2],
      [240, 360, 'mapped', 2, 2],
    ]);
  });

  it('absorbs a single block of another tier between two regions of one tier (A–B–A)', () => {
    const regions = mergeSegments(rows([0, 1, 2, 0, 1])); // slow, slow, MEDIUM, slow, slow
    expect(shape(regions)).toEqual([[0, 300, 'mapped', 0, 5]]);
    expect(shape(mergeSegments(rows([4, 0, 4])))).toEqual([[0, 180, 'mapped', 2, 3]]); // fast, SLOW, fast
  });

  it('does not absorb a run of two or more blocks', () => {
    expect(shape(mergeSegments(rows([0, 2, 2, 0])))).toEqual([
      [0, 60, 'mapped', 0, 1],
      [60, 180, 'mapped', 1, 2],
      [180, 240, 'mapped', 0, 1],
    ]);
  });

  it('does not absorb a block at either end, or between two different tiers', () => {
    expect(mergeSegments(rows([2, 0, 0]))).toHaveLength(2);
    expect(mergeSegments(rows([0, 0, 2]))).toHaveLength(2);
    expect(mergeSegments(rows([0, 2, 4]))).toHaveLength(3);
  });

  it('never merges or absorbs across an unmapped or failed part', () => {
    expect(shape(mergeSegments([m(0, 0), p(60), m(120, 1), f(180), m(240, 0)]))).toEqual([
      [0, 60, 'mapped', 0, 1],
      [60, 120, 'pending', null, 1],
      [120, 180, 'mapped', 0, 1],
      [180, 240, 'failed', null, 1],
      [240, 300, 'mapped', 0, 1],
    ]);
    // A–B–A needs the three to touch: a gap on either side keeps B on its own.
    expect(mergeSegments([m(0, 0), m(60, 2), p(120), m(180, 0)])).toHaveLength(4);
  });

  it('is display only: every block keeps its own exact speed for playback', () => {
    const map = newMap();
    const ratings = [rating(9, 9, 'A'), rating(8, 2, 'B'), rating(5, 3, 'C'), rating(9, 9, 'D')]; // 1×, 1.15×, 1.4×, 1×
    ratings.forEach((r, i) => map.setRating(i, r));
    const tl = goalTimeline(map, pace, 600, 0, true);
    expect(tl.regions[0]).toMatchObject({ tier: 0, blocks: 4, minRate: 1, maxRate: 1.4 }); // drawn as one slow region
    expect(tl.segments.slice(0, 4).map((s) => s.rate)).toEqual([1, 1.15, 1.4, 1]); // still one segment per block
    const g = map.blocks.map((b) => map.pacingBlockAt((b.start + b.end) / 2));
    expect([0, 1, 2, 3].map((i) => goalTarget(g[i]!, pace).rate)).toEqual([1, goalTarget(ratings[1]!, pace).rate, 1.4, 1]);
  });

  it('regroups as blocks arrive progressively', () => {
    const map = newMap();
    const n = map.blocks.length;
    const regions = () => goalTimeline(map, pace, 600, 0, true).regions.map((r) => `${r.state}${r.tier ?? ''}x${r.blocks}`);
    expect(regions()).toEqual([`pendingx${n}`]);
    map.setRating(0, rating(9, 9)); // slow
    map.setRating(2, rating(8, 2)); // slow
    expect(regions()).toEqual(['mapped0x1', 'pendingx1', 'mapped0x1', `pendingx${n - 3}`]); // split by the gap
    map.setRating(1, rating(5)); // medium, between two slow: absorbed
    expect(regions()).toEqual(['mapped0x3', `pendingx${n - 3}`]);
    map.setRating(3, rating(5)); // medium
    map.setRating(4, rating(5)); // medium: a two-block run stays
    expect(regions()).toEqual(['mapped0x3', 'mapped1x2', `pendingx${n - 5}`]);
  });

  it('hover card shows the actual speed, or the range of speeds, inside a region', () => {
    expect(regionTooltip(mergeSegments(rows([0, 0]))[0]!).detail).toBe('Key · 1×');
    expect(regionTooltip(mergeSegments(rows([1, 0, 1]))[0]!).detail).toBe('Important · 1–1.15×');
    expect(regionTooltip(mergeSegments(rows([3, 4, 4]))[0]!).detail).toBe('Not relevant · 1.75–2×');
    expect(regionTooltip(mergeSegments(rows([0, 2, 0]))[0]!).detail).toBe('Key · 1–1.4×'); // absorbed block's speed is shown
  });

  it('hover card names the meaning covering most of the region\'s time (ties: the slower one)', () => {
    expect(regionTooltip(mergeSegments([m(0, 0, undefined, 30), m(30, 1, undefined, 90)])[0]!).detail).toBe('Important · 1–1.15×');
    expect(regionTooltip(mergeSegments([m(0, 1), m(60, 0)])[0]!).detail).toBe('Key · 1–1.15×');
  });

  it('hover card lists the blocks\' own topics, deduplicated', () => {
    const [r] = mergeSegments([m(760, 0, 'Pretraining data'), m(820, 1, 'pretraining  data'), m(880, 0, 'Next-token prediction'), m(940, 0, 'Pretraining data')]);
    expect(regionTooltip(r!)).toEqual({ range: '12:40–16:40', topics: ['Pretraining data', 'Next-token prediction'], more: 0, detail: 'Key · 1–1.15×' });
  });

  it('hover card shows at most 3 topics, then "+N more"', () => {
    const [r] = mergeSegments(['Pretraining data', 'Next-token prediction', 'Training objective', 'Tokenization', 'Compute budget'].map((t, i) => m(760 + i * 39, 0, t, 39)));
    expect(regionTooltip(r!)).toEqual({
      range: '12:40–15:55',
      topics: ['Pretraining data', 'Next-token prediction', 'Training objective'],
      more: 2,
      detail: 'Key · 1×',
    });
  });

  it('hover card skips blocks without a topic and shows the rest', () => {
    const [r] = mergeSegments([m(0, 3, ''), m(60, 3), m(120, 3, 'Sponsor read'), m(180, 3, '  ')]);
    expect(regionTooltip(r!)).toMatchObject({ topics: ['Sponsor read'], more: 0, detail: 'Low relevance · 1.75×' });
  });

  it('a click inside a merged region seeks to that point of it, not its start', () => {
    // A 40-minute video; region 10:00–15:00 drawn on a 272 px map starting at x = 100.
    const duration = 2400;
    const x = (t: number) => 100 + (t / duration) * 272;
    const regionStartX = x(600);
    const regionWidth = x(900) - x(600);
    const clickAt = (fr: number) => seekFromPointer('click', regionStartX + fr * regionWidth, 100, 272, duration)!;
    expect(clickAt(0.1)).toBeCloseTo(630); // ~10:30
    expect(clickAt(0.5)).toBeCloseTo(750); // ~12:30
    expect(clickAt(0.9)).toBeCloseTo(870); // ~14:30
    expect(seekFromPointer('mouseover', regionStartX + regionWidth / 2, 100, 272, duration)).toBeNull(); // hover never seeks
  });

  it('the playhead stays the real video time, inside a merged region too', () => {
    const map = newMap();
    for (let i = 0; i < map.blocks.length; i++) map.setRating(i, rating(i % 2 ? 0 : 3)); // 2× and 1.75× alternating: one fast region
    const tl = goalTimeline(map, pace, 600, 333.3, false);
    expect(tl.regions).toHaveLength(1);
    expect(tl.position).toBe(333.3);
  });
});

describe('region names (presentation only)', () => {
  /** A complete map: blocks rated in runs so they form a few regions, with their own topics. */
  function completeMap() {
    const map = newMap();
    const plan: [number, number, string][] = [
      [9, 9, 'LLM definition'],
      [8, 2, 'Llama 2 weights'],
      [0, 0, 'Sponsor'],
      [1, 0, 'Sponsor'],
      [5, 3, 'Scaling laws'],
      [5, 3, 'Scaling laws'],
      [9, 9, 'Fine-tuning'],
      [9, 9, 'RLHF'],
    ];
    map.blocks.forEach((b, i) => {
      const [r, a, t] = plan[i % plan.length]!;
      map.setRating(i, rating(r, a, t));
    });
    return map;
  }

  it('asks once for every analyzed region, with its blocks\' distinct topics and a stable id', () => {
    const map = completeMap();
    const mapped = goalTimeline(map, pace, 600, 0, false).regions.filter((r) => r.state === 'mapped');
    const { regions, keys } = regionLabelRequest(map);
    expect(regions).toHaveLength(mapped.length);
    expect(regions.map((r) => r.id)).toEqual(mapped.map((_, i) => String(i + 1)));
    expect(regions[0]!.topics).toEqual(['LLM definition', 'Llama 2 weights']);
    expect([...keys.values()]).toEqual(mapped.map(regionKey));
  });

  it('leaves failed parts out and stays bounded', () => {
    const map = newMap();
    map.blocks.forEach((b, i) => (i % 2 ? map.setFailed(i) : map.setRating(i, rating(i % 4 ? 9 : 0, 9, `topic ${i}`))));
    const { regions } = regionLabelRequest(map);
    expect(regions.every((r) => r.topics.length > 0 && r.topics.length <= 6)).toBe(true);
    expect(regions.length).toBeLessThanOrEqual(24);
    expect(regions.length).toBe(goalTimeline(map, pace, 600, 0, false).regions.filter((r) => r.state === 'mapped').length);
  });

  it('a name replaces the topic list in the hover card; time range, meaning and speed stay', () => {
    const map = completeMap();
    const before = goalTimeline(map, pace, 600, 0, false);
    const r0 = before.regions[0]!;
    expect(regionTooltip(r0).topics).toEqual(['LLM definition', 'Llama 2 weights']); // until named
    map.setRegionNames(new Map([[regionKey(r0), 'LLM basics']]));
    const after = goalTimeline(map, pace, 600, 0, false);
    expect(regionTooltip(after.regions[0]!)).toEqual({ ...regionTooltip(r0), topics: ['LLM basics'], more: 0 });
    // Presentation only: same regions, same blocks, same speeds.
    expect(after.regions.map(({ name: _n, ...r }) => r)).toEqual(before.regions);
    expect(after.segments).toEqual(before.segments);
  });

  it('regions without a name keep their topic list', () => {
    const map = completeMap();
    const tl = goalTimeline(map, pace, 600, 0, false);
    map.setRegionNames(new Map([[regionKey(tl.regions[0]!), 'LLM basics']]));
    const second = goalTimeline(map, pace, 600, 0, false).regions[1]!;
    expect(second.name).toBeUndefined();
    expect(regionTooltip(second).topics.length).toBeGreaterThan(0);
  });
});

describe('Goal Map status line', () => {
  const at = (map: GoalMap, position: number, mapping = true) => goalTimeline(map, pace, 600, position, mapping);
  const clockOf = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

  it('says how far playback is covered from here: the end of the unbroken analyzed run', () => {
    const map = newMap();
    [0, 1, 2].forEach((i) => map.setRating(i, rating(5)));
    const tl = at(map, 5);
    expect(readyThrough(tl)).toBe(map.blocks[2]!.end);
    expect(mapStatus(tl)).toBe(`Ready through ${clockOf(map.blocks[2]!.end)}`);
  });

  it('ignores blocks analyzed further ahead past a gap (mapping is not always in order)', () => {
    const map = newMap();
    map.setRating(0, rating(5));
    map.setRating(3, rating(5)); // analyzed out of order: 1 and 2 aren't yet
    map.setRating(4, rating(5));
    expect(readyThrough(at(map, 5))).toBe(map.blocks[0]!.end);
  });

  it('stops at a failed block', () => {
    const map = newMap();
    map.setRating(0, rating(5));
    map.setFailed(1);
    map.setRating(2, rating(5));
    expect(readyThrough(at(map, 5))).toBe(map.blocks[0]!.end);
  });

  it('says "Analyzing ahead…" when the current part is not analyzed yet', () => {
    const map = newMap();
    map.setRating(3, rating(5)); // ahead of the viewer, not where they are
    const tl = at(map, 5);
    expect(readyThrough(tl)).toBeNull();
    expect(mapStatus(tl)).toBe('Analyzing ahead…');
    map.setFailed(0);
    expect(mapStatus(at(map, 5))).toBe('Analyzing ahead…');
  });

  it('follows the playhead: after a seek, coverage is counted from the new position', () => {
    const map = newMap();
    [0, 1, 4, 5].forEach((i) => map.setRating(i, rating(5)));
    expect(readyThrough(at(map, 5))).toBe(map.blocks[1]!.end);
    const mid = (map.blocks[4]!.start + map.blocks[4]!.end) / 2;
    expect(readyThrough(at(map, mid))).toBe(map.blocks[5]!.end);
  });

  it('never shows a percentage, and shows nothing once the map is complete', () => {
    const map = newMap();
    map.setRating(0, rating(5));
    for (const p of [0, 5, 300, 599]) expect(mapStatus(at(map, p))).not.toMatch(/%|Mapping/);
    map.blocks.forEach((b, i) => map.setRating(i, rating(5)));
    expect(mapStatus(at(map, 5, false))).toBe('');
  });
});
