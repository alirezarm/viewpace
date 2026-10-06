import { describe, expect, it } from 'vitest';
import { PROFILES } from '../src/content/controller';
import { makeBlocks } from '../src/content/goal/blocks';
import { GoalMap, SECTION_WINDOW } from '../src/content/goal/goal-map';
import { GOAL_PACING, goalTarget } from '../src/content/goal/goal-pacing';
import type { TimedWord } from '../src/shared/types';

const rating = (relevance: number, attention = 3, topic = 't') => ({ topic, relevance, attention, reason: 'r' });

/** Words every 0.4 s, with a 3 s pause after every `pauseEvery` seconds. */
function speech(seconds: number, pauseEvery = 50): TimedWord[] {
  const words: TimedWord[] = [];
  let t = 2;
  let i = 0;
  while (t < seconds) {
    words.push({ t, w: `w${i++}` });
    t += 0.4;
    if (Math.floor(t) % pauseEvery === 0 && Math.floor(t - 0.4) % pauseEvery !== 0) t += 3;
  }
  return words;
}

describe('deterministic relevance/attention → pacing', () => {
  const normal = PROFILES.normal; // 1.0–2.0×
  it('maps the categories onto the pace range', () => {
    expect(goalTarget({ relevance: 1, attention: 9 }, normal)).toEqual({ rate: 2, label: 'Not relevant to your goal' });
    expect(goalTarget({ relevance: 4, attention: 2 }, normal)).toEqual({ rate: 1.75, label: 'Less relevant to your goal' });
    expect(goalTarget({ relevance: 6, attention: 9 }, normal)).toEqual({ rate: 1.4, label: 'Relevant background' });
    expect(goalTarget({ relevance: 8, attention: 4 }, normal).rate).toBeCloseTo(1.15);
    expect(goalTarget({ relevance: 8, attention: 4 }, normal).label).toBe('Important for your goal');
    expect(goalTarget({ relevance: 9, attention: 8 }, normal)).toEqual({ rate: 1, label: 'Key part for your goal' });
  });

  it('is slower for higher relevance, and slowest for high relevance + high attention', () => {
    const rates = [0, 3, 5, 7].map((r) => goalTarget({ relevance: r, attention: 0 }, normal).rate);
    expect([...rates].sort((a, b) => b - a)).toEqual(rates);
    expect(goalTarget({ relevance: 10, attention: 10 }, normal).rate).toBe(normal.minRate);
  });

  it('respects the chosen pace', () => {
    expect(goalTarget({ relevance: 0, attention: 0 }, PROFILES.relaxed).rate).toBe(PROFILES.relaxed.maxRate);
    expect(goalTarget({ relevance: 10, attention: 10 }, PROFILES.fast).rate).toBe(PROFILES.fast.minRate);
  });

  it('always ends with a catch-all category', () => {
    const last = GOAL_PACING[GOAL_PACING.length - 1]!;
    expect([last.minRelevance, last.minAttention]).toEqual([0, 0]);
  });
});

describe('blocks', () => {
  it('cover the timeline without gaps or overlaps, cut at pauses, within bounds', () => {
    const words = speech(600);
    const blocks = makeBlocks(words, 605);
    expect(blocks[0]!.start).toBe(0);
    expect(blocks.at(-1)!.end).toBe(605);
    for (let i = 1; i < blocks.length; i++) expect(blocks[i]!.start).toBe(blocks[i - 1]!.end);
    for (const b of blocks.slice(0, -1)) {
      expect(b.end - b.start).toBeLessThanOrEqual(100 + 3);
      expect(b.text.split(' ').length).toBeLessThanOrEqual(300);
    }
    // Every cut lands right after one of the 3-second pauses.
    for (const b of blocks.slice(1)) {
      const before = words.filter((w) => w.t < b.start).at(-1)!;
      expect(b.start - before.t).toBeGreaterThan(3);
    }
  });

  it('returns nothing for an empty transcript', () => {
    expect(makeBlocks([], 100)).toEqual([]);
  });
});

describe('video map: block-level pacing', () => {
  const blocks = [0, 60, 120, 180].map((s, i) => ({ index: i, start: s, end: s + 60, text: '' }));

  it('finds the block containing a timestamp, including at boundaries', () => {
    const m = new GoalMap(blocks);
    blocks.forEach((b) => m.setRating(b.index, rating(b.index * 3)));
    expect(m.pacingBlockAt(0)!.relevance).toBe(0);
    expect(m.pacingBlockAt(59.9)!.relevance).toBe(0);
    expect(m.pacingBlockAt(60)!.relevance).toBe(3); // start is inclusive, end exclusive
    expect(m.pacingBlockAt(239)!.relevance).toBe(9);
    expect(m.pacingBlockAt(240)).toBeNull(); // beyond the transcript
    expect(m.pacingBlockAt(70)).toMatchObject({ index: 1, start: 60, end: 120 });
  });

  it('never invents coverage for unanalysed or failed blocks', () => {
    const m = new GoalMap(blocks);
    m.setRating(0, rating(5));
    m.setFailed(1);
    m.setRating(3, rating(8));
    expect(m.pacingBlockAt(30)).not.toBeNull();
    expect(m.pacingBlockAt(90)).toBeNull(); // failed
    expect(m.pacingBlockAt(150)).toBeNull(); // not analysed yet
    expect(m.pacingBlockAt(200)).not.toBeNull();
    expect(m.failedCount).toBe(1);
  });

  it('paces each block by its own scores even inside a section with one highly relevant block', () => {
    // Regression: sections used to take the max relevance, so one R9 block slowed the whole section.
    const m = new GoalMap(blocks);
    m.setRating(0, rating(1, 2, 'intro'));
    m.setRating(1, rating(9, 4, 'training'));
    m.setRating(2, rating(2, 2, 'anecdote'));
    m.setRating(3, rating(1, 1, 'outro'));
    m.setSections(0, [{ from: 0, to: 3, topic: 'Whole talk' }]);
    expect(m.pacingBlockAt(30)!.relevance).toBe(1);
    expect(m.pacingBlockAt(90)!.relevance).toBe(9);
    expect(m.pacingBlockAt(150)!.relevance).toBe(2);
    const pace = PROFILES.normal;
    expect(goalTarget(m.pacingBlockAt(30)!, pace).rate).toBe(2); // still fast
    expect(goalTarget(m.pacingBlockAt(90)!, pace).rate).toBeCloseTo(1.15); // only the relevant block is slow
  });
});

describe('video map: sections are labels only', () => {
  const blocks = [0, 60, 120, 180].map((s, i) => ({ index: i, start: s, end: s + 60, text: '' }));
  const rateAll = (m: GoalMap) => blocks.forEach((b) => m.setRating(b.index, rating(b.index * 3, 2, `t${b.index}`)));

  it('exposes validated sections with topics and ranges but no scores', () => {
    const m = new GoalMap(blocks);
    rateAll(m);
    m.setSections(0, [
      { from: 0, to: 0, topic: 'Intro' },
      { from: 1, to: 2, topic: 'How the agent was trained' },
      { from: 3, to: 3, topic: 'Outro' },
    ]);
    expect(m.sections().map((s) => [s.start, s.end, s.topic])).toEqual([
      [0, 60, 'Intro'],
      [60, 180, 'How the agent was trained'],
      [180, 240, 'Outro'],
    ]);
    const s = m.sectionAt(130)!;
    expect(s.topic).toBe('How the agent was trained');
    expect('relevance' in s || 'attention' in s).toBe(false);
  });

  it('shows no sections until every block in their window is rated', () => {
    const m = new GoalMap(blocks);
    m.setRating(0, rating(2));
    m.setSections(0, [{ from: 0, to: 3, topic: 'All' }]);
    expect(m.sections()).toEqual([]);
    expect(m.sectionAt(10)).toBeNull();
  });

  it('bounds section windows', () => {
    const many = Array.from({ length: SECTION_WINDOW * 2 + 5 }, (_, i) => ({ index: i, start: i * 60, end: i * 60 + 60, text: '' }));
    const m = new GoalMap(many);
    expect(m.windowCount).toBe(3);
    expect(m.windowRange(2)).toEqual([SECTION_WINDOW * 2, SECTION_WINDOW * 2 + 4]);
  });
});

describe('debug outline', () => {
  const blocks = [0, 60, 120, 180].map((s, i) => ({ index: i, start: s, end: s + 60, text: '' }));

  it('lists every block (rated, failed or pending) with section headings before the blocks they start', () => {
    const m = new GoalMap(blocks);
    m.setRating(0, rating(1));
    m.setRating(1, rating(8));
    m.setFailed(2);
    const o1 = m.outline();
    expect(o1.map((e) => (e.kind === 'section' ? 'S' : e.block ? 'rated' : e.failed ? 'failed' : 'pending'))).toEqual([
      'rated',
      'rated',
      'failed',
      'pending',
    ]);

    m.setRating(2, rating(3));
    m.setRating(3, rating(4));
    m.setSections(0, [
      { from: 0, to: 1, topic: 'A' },
      { from: 2, to: 3, topic: 'B' },
    ]);
    const o2 = m.outline();
    expect(o2.map((e) => (e.kind === 'section' ? `S:${e.section.topic}` : `b${e.index}`))).toEqual(['S:A', 'b0', 'b1', 'S:B', 'b2', 'b3']);
  });
});
