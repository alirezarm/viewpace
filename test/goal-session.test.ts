import { describe, expect, it } from 'vitest';
import { PROFILES } from '../src/content/controller';
import { GoalController, type GoalAnalyzer } from '../src/content/goal/goal-session';
import { goalTarget } from '../src/content/goal/goal-pacing';
import type { TimedWord } from '../src/shared/types';

const pace = PROFILES.normal;
/** ~10 minutes of speech with a pause every 50 s (gives several blocks). */
const words: TimedWord[] = [];
for (let t = 1, i = 0; t < 600; t += 0.4, i++) {
  words.push({ t, w: `w${i}` });
  if (i % 120 === 119) t += 3;
}

function analyzer(opts: Partial<{ available: boolean; fail: (n: number) => boolean; relevance: number; gate: Promise<void> }> = {}) {
  let calls = 0;
  const a: GoalAnalyzer & { calls: () => number } = {
    available: async () => opts.available ?? true,
    rateBlock: async () => {
      const n = calls++;
      if (opts.gate) await opts.gate;
      if (opts.fail?.(n)) throw new Error('model error');
      return { topic: 'training details', relevance: opts.relevance ?? 8, attention: 3, reason: 'about training' };
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
    await g.start(baseStart(analyzer({ relevance: 0 })));
    await flush();
    expect(g.decide('A', 100, pace, true)).toEqual({ kind: 'hold', note: 'Paused: you chose the speed' });
  });

  it('targets the speed of the current block, with its section only as a label', async () => {
    const g = new GoalController();
    let n = 0;
    const a: GoalAnalyzer = {
      available: async () => true,
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

  it('stops on request', async () => {
    const g = new GoalController();
    await g.start(baseStart(analyzer()));
    g.stop();
    expect(g.decide('A', 100, pace)).toEqual({ kind: 'off' });
  });
});
