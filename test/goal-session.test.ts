import { describe, expect, it } from 'vitest';
import { PROFILES } from '../src/content/controller';
import { GoalController, type GoalAnalyzer } from '../src/content/goal/goal-session';
import { goalTarget } from '../src/content/goal/goal-pacing';
import { parseBlockRating } from '../src/shared/goal-prompt';
import type { TimedWord } from '../src/shared/types';

const pace = PROFILES.normal;
/** ~10 minutes of speech with a pause every 50 s (gives several blocks). */
const words: TimedWord[] = [];
for (let t = 1, i = 0; t < 600; t += 0.4, i++) {
  words.push({ t, w: `w${i}` });
  if (i % 120 === 119) t += 3;
}

/** The model's raw structured output for a block, as the background worker parses it. */
const modelOutput = (relevance: unknown, attention = 3) => parseBlockRating(JSON.stringify({ topic: 'training details', relevance, attention, reason: 'about training' }));

function analyzer(opts: Partial<{ available: boolean; fail: (n: number) => boolean; relevance: number; gate: Promise<void> }> = {}) {
  let calls = 0;
  const a: GoalAnalyzer & { calls: () => number } = {
    available: async () => opts.available ?? true,
    breakdownGoal: async () => ['how the agent was trained', 'how it was evaluated', 'training data'],
    rateBlock: async () => {
      const n = calls++;
      if (opts.gate) await opts.gate;
      if (opts.fail?.(n)) throw new Error('model error');
      return modelOutput(opts.relevance ?? 8);
    },
    groupSections: async () => null,
    calls: () => calls,
  };
  return a;
}
const flush = async () => {
  for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0));
};
const baseStart = (a: GoalAnalyzer, isCurrent = () => true) => ({
  videoId: 'A', goal: 'I want to understand how the agent was trained and evaluated.', words, transcriptEnd: 600,
  analyzer: a, isCurrent, startAt: 0,
});

describe('Goal Mode', () => {
  it('maps the video and then targets the deterministic speed for the current region', async () => {
    const g = new GoalController();
    const a = analyzer({ relevance: 1 });
    await g.start(baseStart(a));
    await flush();
    expect(g.status('A')!.phase).toBe('ready');
    const d = g.decide('A', 100, pace);
    expect(d).toMatchObject({ kind: 'target', rate: 2, label: 'Not relevant to your goal' });
  });

  it('does nothing without a transcript and explains why', async () => {
    const g = new GoalController();
    const a = analyzer();
    const st = await g.start({ ...baseStart(a), words: null });
    expect(st!.phase).toBe('no-transcript');
    expect(st!.message).toMatch(/captions/);
    expect(a.calls()).toBe(0);
    expect(g.decide('A', 10, pace)).toEqual({ kind: 'off' }); // playback unchanged by Goal Mode
  });

  it('explains that the on-device AI is required when Nano is unavailable', async () => {
    const g = new GoalController();
    const a = analyzer({ available: false });
    const st = await g.start(baseStart(a));
    expect(st!.phase).toBe('no-ai');
    expect(st!.message).toMatch(/Smart Pacing/);
    expect(a.calls()).toBe(0);
    expect(g.decide('A', 10, pace)).toEqual({ kind: 'off' });
  });

  it('leaves playback unchanged when every analysis fails', async () => {
    const g = new GoalController();
    await g.start(baseStart(analyzer({ fail: () => true })));
    await flush();
    expect(g.status('A')!.phase).toBe('failed');
    expect(g.decide('A', 100, pace).kind).toBe('hold');
  });

  it('never invents coverage: failed parts hold, mapped parts target', async () => {
    const g = new GoalController();
    // Fail both attempts of the first block only.
    await g.start(baseStart(analyzer({ fail: (n) => n < 2 })));
    await flush();
    const st = g.status('A')!;
    expect(st.phase).toBe('ready');
    expect(st.failed).toBe(1);
    expect(g.decide('A', 5, pace).kind).toBe('hold'); // first block failed
    expect(g.decide('A', 300, pace).kind).toBe('target');
  });

  it('clears goal, map and analysis on video change', async () => {
    const g = new GoalController();
    await g.start(baseStart(analyzer()));
    await flush();
    expect(g.active('A')).toBe(true);
    g.onVideoChange('B');
    expect(g.active('A')).toBe(false);
    expect(g.status('B')).toBeNull();
    expect(g.decide('B', 100, pace)).toEqual({ kind: 'off' });
  });

  it('discards analysis results that arrive after navigating away', async () => {
    const g = new GoalController();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let current = 'A';
    const a = analyzer({ gate });
    await g.start(baseStart(a, () => current === 'A'));
    const session = g.session!;
    current = 'B'; // the user navigates while the first block is being analysed
    g.onVideoChange('B');
    release();
    await flush();
    expect(session.map.rated).toBe(0); // the late result was dropped
    expect(a.calls()).toBe(1); // and no further blocks were analysed
    expect(g.decide('B', 100, pace)).toEqual({ kind: 'off' });
  });

  it('holds while the current part is still being mapped', async () => {
    const g = new GoalController();
    const gate = new Promise<void>(() => {}); // never resolves
    await g.start(baseStart(analyzer({ gate })));
    expect(g.decide('A', 100, pace)).toEqual({ kind: 'hold', note: 'Mapping this part for your goal…' });
  });

  it('never overrides a speed the user chose', async () => {
    const g = new GoalController();
    await g.start(baseStart(analyzer({ relevance: 1 })));
    await flush();
    expect(g.decide('A', 100, pace, true)).toEqual({ kind: 'hold', note: 'Paused: you chose the speed' });
  });

  it('targets the speed of the current block, with its section only as a label', async () => {
    const g = new GoalController();
    let n = 0;
    const a: GoalAnalyzer = {
      available: async () => true,
      breakdownGoal: async () => ['a', 'b', 'c'],
      // Alternate low and high relevance per block.
      rateBlock: async () => ({ topic: `part ${n}`, relevance: n++ % 2 ? 9 : 1, attention: 3, reason: n % 2 ? 'off-topic' : 'about training' }),
      // One section spanning everything: must not change any block's speed.
      groupSections: async (_g, _p, first, last) => [{ from: first, to: last, topic: 'The whole talk' }],
    };
    await g.start(baseStart(a));
    await flush();
    const blocks = g.session!.map.blocks;
    const speeds = blocks.map((b) => {
      const d = g.decide('A', (b.start + b.end) / 2, pace);
      if (d.kind !== 'target') throw new Error('expected a target');
      expect(d.section?.topic).toBe('The whole talk');
      expect(d.rate).toBe(d.block.relevance >= 7 ? goalTarget(d.block, pace).rate : 2);
      return d.rate;
    });
    expect(new Set(speeds).size).toBe(2); // fast and slow blocks both survive inside one section
  });

  it('paces model relevance scores through the speed table', async () => {
    const expected: [number, number, string][] = [
      [2, 2, 'Not relevant to your goal'],
      [3, 1.75, 'Less relevant to your goal'],
      [5, 1.4, 'Relevant background'],
      [7, 1.15, 'Important for your goal'],
    ];
    for (const [relevance, rate, label] of expected) {
      const g = new GoalController();
      await g.start(baseStart(analyzer({ relevance })));
      await flush();
      const d = g.decide('A', 100, pace);
      if (d.kind !== 'target') throw new Error('expected a target');
      expect(d.rate).toBeCloseTo(rate);
      expect(d.label).toBe(label);
      expect(d.block.relevance).toBe(relevance);
    }
  });

  it('retries a block whose model output is invalid, then leaves it unmapped', async () => {
    const g = new GoalController();
    let calls = 0;
    const a: GoalAnalyzer = {
      available: async () => true,
      breakdownGoal: async () => ['a', 'b', 'c'],
      // The first block's two attempts return a non-numeric relevance (the parser rejects it); the rest are fine.
      rateBlock: async () => modelOutput(calls++ < 2 ? 'very relevant' : 10, 8),
      groupSections: async () => null,
    };
    await g.start(baseStart(a));
    await flush();
    const st = g.status('A')!;
    expect(st.failed).toBe(1);
    expect(g.decide('A', 5, pace).kind).toBe('hold'); // no invented speed for the failed block
    expect(g.decide('A', 300, pace)).toMatchObject({ kind: 'target', rate: 1, label: 'Key part for your goal' });
  });

  describe('fixed goal breakdown (POC 1.5)', () => {
    const NEEDS = ['generating an SSH key', 'adding the key to GitHub', 'testing the connection'];
    /** Records what each block call received; the breakdown can be made to fail. */
    function needsAnalyzer(breakdown: () => Promise<string[]>) {
      const seen: (string[] | null | undefined)[] = [];
      let breakdowns = 0;
      const a: GoalAnalyzer = {
        available: async () => true,
        breakdownGoal: async () => {
          breakdowns++;
          return breakdown();
        },
        rateBlock: async (_goal, _text, _title, needs) => {
          seen.push(needs);
          return modelOutput(5);
        },
        groupSections: async () => null,
      };
      return { a, seen, breakdowns: () => breakdowns };
    }

    it('breaks the goal down once and gives every block the same needs', async () => {
      const g = new GoalController();
      const { a, seen, breakdowns } = needsAnalyzer(async () => NEEDS);
      await g.start(baseStart(a));
      await flush();
      expect(breakdowns()).toBe(1);
      expect(seen.length).toBe(g.session!.map.blocks.length);
      for (const n of seen) expect(n).toEqual(NEEDS);
      expect(g.session!.needs).toEqual(NEEDS);
      expect(g.status('A')!.phase).toBe('ready');
    });

    it('falls back to scoring without a breakdown when it fails', async () => {
      const g = new GoalController();
      const { a, seen } = needsAnalyzer(async () => {
        throw new Error('too few needs');
      });
      await g.start(baseStart(a));
      await flush();
      expect(g.session!.needs).toBeNull();
      expect(seen.length).toBe(g.session!.map.blocks.length);
      for (const n of seen) expect(n).toBeNull();
      expect(g.status('A')!.phase).toBe('ready');
      expect(g.decide('A', 100, pace)).toMatchObject({ kind: 'target', rate: 1.4 });
    });

    it('does not rate blocks for a session stopped while the breakdown runs', async () => {
      const g = new GoalController();
      let release!: () => void;
      const { a, seen } = needsAnalyzer(() => new Promise((r) => (release = () => r(NEEDS))));
      await g.start(baseStart(a));
      g.stop();
      release();
      await flush();
      expect(seen.length).toBe(0);
    });
  });

  it('stops on request', async () => {
    const g = new GoalController();
    await g.start(baseStart(analyzer()));
    g.stop();
    expect(g.decide('A', 100, pace)).toEqual({ kind: 'off' });
  });
});
