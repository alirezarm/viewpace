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

describe('video map', () => {
  const blocks = [0, 60, 120, 180].map((s, i) => ({ index: i, start: s, end: s + 60, text: '' }));

  it('finds the region containing a timestamp, including at boundaries', () => {
    const m = new GoalMap(blocks);
    blocks.forEach((b) => m.setRating(b.index, rating(b.index * 3)));
    expect(m.regionAt(0)!.relevance).toBe(0);
    expect(m.regionAt(59.9)!.relevance).toBe(0);
    expect(m.regionAt(60)!.relevance).toBe(3); // start is inclusive, end exclusive
    expect(m.regionAt(239)!.relevance).toBe(9);
    expect(m.regionAt(240)).toBeNull(); // beyond the transcript
  });

  it('never invents coverage for unanalysed or failed blocks', () => {
    const m = new GoalMap(blocks);
    m.setRating(0, rating(5));
    m.setFailed(1);
    m.setRating(3, rating(8));
    expect(m.regionAt(30)).not.toBeNull();
    expect(m.regionAt(90)).toBeNull(); // failed
    expect(m.regionAt(150)).toBeNull(); // not analysed yet
    expect(m.regionAt(200)).not.toBeNull();
    expect(m.failedCount).toBe(1);
  });

  it('merges validated sections: highest relevance, average attention', () => {
    const m = new GoalMap(blocks);
    m.setRating(0, rating(2, 2, 'intro'));
    m.setRating(1, rating(9, 4, 'training'));
    m.setRating(2, rating(6, 8, 'training'));
    m.setRating(3, rating(1, 1, 'outro'));
    m.setSections(0, [
      { from: 0, to: 0, topic: 'Intro' },
      { from: 1, to: 2, topic: 'How the agent was trained' },
      { from: 3, to: 3, topic: 'Outro' },
    ]);
    const rs = m.regions();
    expect(rs.map((r) => [r.start, r.end])).toEqual([[0, 60], [60, 180], [180, 240]]);
    expect(rs[1]).toMatchObject({ topic: 'How the agent was trained', relevance: 9, attention: 6 });
  });

  it('ignores sections until every block in their window is rated', () => {
    const m = new GoalMap(blocks);
    m.setRating(0, rating(2));
    m.setSections(0, [{ from: 0, to: 3, topic: 'All' }]);
    expect(m.regions()).toHaveLength(1); // block 0 only, not a merged region over unrated blocks
    expect(m.regionAt(200)).toBeNull();
  });

  it('bounds section windows', () => {
    const many = Array.from({ length: SECTION_WINDOW * 2 + 5 }, (_, i) => ({ index: i, start: i * 60, end: i * 60 + 60, text: '' }));
    const m = new GoalMap(many);
    expect(m.windowCount).toBe(3);
    expect(m.windowRange(2)).toEqual([SECTION_WINDOW * 2, SECTION_WINDOW * 2 + 4]);
  });
});
