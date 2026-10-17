import { describe, expect, it } from 'vitest';
import { PROFILES } from '../src/content/controller';
import { GoalController, type GoalAnalyzer } from '../src/content/goal/goal-session';
import { goalTarget } from '../src/content/goal/goal-pacing';
import { goalTimeline, regionTooltip, seekFromPointer } from '../src/content/goal/goal-timeline';
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
  analyzer: a, isCurrent, playhead: () => 0,
});

describe('Goal Mode', () => {
  it('maps the video and then targets the deterministic speed for the current region', async () => {
    const g = new GoalController();
    const a = analyzer({ relevance: 1 });
    await g.start(baseStart(a));
    await flush();
    expect(g.status('A')!.phase).toBe('ready');
    const d = g.decide('A', 100, pace);
    expect(d).toMatchObject({ kind: 'target', rate: 2, label: 'Not relevant' });
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
    expect(g.decide('A', 100, pace)).toEqual({ kind: 'hold', note: 'Analyzing this part…' });
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
      [2, 2, 'Not relevant'],
      [3, 1.75, 'Low relevance'],
      [5, 1.4, 'Relevant'],
      [7, 1.15, 'Important'],
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
    expect(g.decide('A', 300, pace)).toMatchObject({ kind: 'target', rate: 1, label: 'Key' });
  });

  describe('goal breakdown', () => {
    const NEEDS = ['generating an SSH key', 'adding the key to GitHub', 'testing the connection'];
    /** Records every call's arguments; the breakdown and the block ratings can be controlled. */
    function needsAnalyzer(breakdown: () => Promise<string[]>, relevance: (n: number) => number = () => 5) {
      const seen: (string[] | null | undefined)[] = [];
      const blockArgs: unknown[][] = [];
      const breakdownArgs: unknown[][] = [];
      const a: GoalAnalyzer = {
        available: async () => true,
        breakdownGoal: async (...args) => {
          breakdownArgs.push(args);
          return breakdown();
        },
        rateBlock: async (...args) => {
          seen.push(args[3]);
          blockArgs.push(args);
          return modelOutput(relevance(blockArgs.length - 1));
        },
        groupSections: async () => null,
      };
      return { a, seen, blockArgs, breakdownArgs, breakdowns: () => breakdownArgs.length };
    }

    it('breaks the goal down once, from the goal alone, and gives every block the same needs', async () => {
      const g = new GoalController();
      const { a, seen, breakdowns, breakdownArgs } = needsAnalyzer(async () => NEEDS);
      await g.start({ ...baseStart(a), title: 'Some video' });
      await flush();
      expect(breakdowns()).toBe(1);
      expect(breakdownArgs[0]).toEqual([baseStart(a).goal]); // no transcript, no title
      expect(seen.length).toBe(g.session!.map.blocks.length);
      for (const n of seen) expect(n).toEqual(NEEDS);
      expect(g.session!.needs).toEqual(NEEDS);
      expect(g.status('A')!.phase).toBe('ready');
    });

    it('rates each block independently of the others', async () => {
      // Two sessions whose model ratings differ wildly; every block is still asked the same thing.
      const run = async (relevance: (n: number) => number) => {
        const g = new GoalController();
        const r = needsAnalyzer(async () => NEEDS, relevance);
        await g.start(baseStart(r.a));
        await flush();
        return { g, args: r.blockArgs };
      };
      const low = await run(() => 0);
      const mixed = await run((n) => (n % 2 ? 10 : 0));
      expect(mixed.args).toEqual(low.args);
      expect(new Set(low.args.map((x) => x[1])).size).toBe(low.args.length); // one call per block
      // And each block keeps its own rating.
      expect(low.g.decide('A', 100, pace)).toMatchObject({ kind: 'target', rate: 2 });
      const speeds = mixed.g.session!.map.blocks.map((b) => (mixed.g.decide('A', b.start + 1, pace) as { rate: number }).rate);
      expect(new Set(speeds)).toEqual(new Set([1.15, 2]));
    });

    it('falls back to rating from the goal alone when the breakdown fails', async () => {
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

    it('drops a breakdown that arrives after navigating away', async () => {
      const g = new GoalController();
      let release!: () => void;
      let current = 'A';
      const { a, seen } = needsAnalyzer(() => new Promise((r) => (release = () => r(NEEDS))));
      await g.start(baseStart(a, () => current === 'A'));
      const session = g.session!;
      current = 'B';
      g.onVideoChange('B');
      release();
      await flush();
      expect(seen.length).toBe(0);
      expect(session.map.rated).toBe(0);
      expect(g.session).toBeNull();
      expect(g.decide('B', 100, pace)).toEqual({ kind: 'off' });
    });
  });

  describe('progressive mapping', () => {
    /**
     * Each block call waits until the test releases it, so the test can look at the state between
     * blocks. `order` records which block (by its first word) each call was for.
     */
    function stepAnalyzer(opts: { relevance?: (block: string) => number; sections?: () => Promise<null> } = {}) {
      const order: string[] = [];
      const waiting: (() => void)[] = [];
      const events: string[] = [];
      const a: GoalAnalyzer = {
        available: async () => true,
        breakdownGoal: async () => ['a', 'b', 'c'],
        rateBlock: async (_g, text) => {
          const block = text.split(' ')[0]!;
          order.push(block);
          events.push(`block ${block}`);
          await new Promise<void>((r) => waiting.push(r));
          return modelOutput(opts.relevance?.(block) ?? 1);
        },
        groupSections: async () => {
          events.push('sections');
          return opts.sections ? opts.sections() : null;
        },
      };
      /** Let the oldest waiting call finish, then let the loop pick its next block. */
      const step = async () => {
        await flush();
        waiting.shift()?.();
        await flush();
      };
      return { a, order, events, step, waiting: () => waiting.length };
    }
    const firstWords = (g: GoalController) => g.session!.map.blocks.map((b) => b.text.split(' ')[0]!);

    it('makes each block usable for playback as soon as it is rated, before the map is complete', async () => {
      const g = new GoalController();
      const { a, step } = stepAnalyzer();
      await g.start(baseStart(a));
      await flush();
      expect(g.decide('A', 10, pace)).toEqual({ kind: 'hold', note: 'Analyzing this part…' });
      await step(); // first block done
      expect(g.status('A')!.phase).toBe('mapping');
      expect(g.decide('A', 10, pace)).toMatchObject({ kind: 'target', rate: 2 });
      expect(g.decide('A', 300, pace).kind).toBe('hold'); // later parts aren't mapped yet
      expect(g.status('A')!.message).toMatch(/^Analyzing ahead…/);
      expect(g.status('A')!.message).not.toMatch(/%/);
    });

    it('starts at the playhead and works forward, then wraps to the start', async () => {
      const g = new GoalController();
      const { a, order, step } = stepAnalyzer();
      await g.start({ ...baseStart(a), playhead: () => 300 });
      const blocks = firstWords(g);
      const k = g.session!.map.blockAt(300);
      expect(k).toBeGreaterThan(0);
      for (let i = 0; i < blocks.length; i++) await step();
      expect(order).toEqual([...blocks.slice(k), ...blocks.slice(0, k)]);
    });

    it('follows a seek into an unmapped part, and never rates a block twice', async () => {
      const g = new GoalController();
      let playhead = 0;
      const { a, order, step } = stepAnalyzer();
      await g.start({ ...baseStart(a), playhead: () => playhead });
      const blocks = firstWords(g);
      const map = g.session!.map;
      await step(); // block 0 rated
      expect(order).toEqual([blocks[0], blocks[1]]); // block 1 is in flight
      playhead = 450; // the viewer jumps ahead into unmapped video
      await step(); // block 1 finishes; the next pick follows the playhead
      const j = map.blockAt(450);
      expect(order.at(-1)).toBe(blocks[j]);
      await step();
      expect(order.at(-1)).toBe(blocks[(j + 1) % blocks.length]);
      playhead = 5; // back into the part that's already mapped: carry on with the first unmapped block after it
      for (let i = 0; i < blocks.length; i++) await step();
      expect(new Set(order).size).toBe(order.length); // each block rated exactly once
      expect([...order].sort()).toEqual([...blocks].sort());
      expect(g.status('A')!.phase).toBe('ready');
    });

    it('a Goal Map click moves the real video, the map follows it, and mapping goes there next', async () => {
      const g = new GoalController();
      const video = { currentTime: 0, duration: 600 }; // the only playback state: the video's own
      const { a, order, step } = stepAnalyzer();
      await g.start({ ...baseStart(a), playhead: () => video.currentTime });
      const blocks = firstWords(g);
      const map = g.session!.map;
      await step(); // block 0 rated, block 1 in flight
      // What the badge's onSeek does: a click at 75% of the map sets the video's time.
      const t = seekFromPointer('click', 100 + 0.75 * 272, 100, 272, video.duration)!;
      video.currentTime = t;
      expect(t).toBe(450);
      expect(goalTimeline(map, pace, video.duration, video.currentTime, true).position).toBe(450); // playhead redraws there
      expect(g.decide('A', video.currentTime, pace)).toEqual({ kind: 'hold', note: 'Analyzing this part…' }); // unmapped: speed left alone
      await step(); // block 1 finishes; the next pick follows the new position
      const j = map.blockAt(450);
      expect(order.at(-1)).toBe(blocks[j]);
      await step();
      expect(g.decide('A', video.currentTime, pace).kind).toBe('target'); // usable as soon as it lands
    });

    it('does not keep retrying a failed block while the viewer stays on it', async () => {
      const g = new GoalController();
      let calls = 0;
      const a: GoalAnalyzer = {
        available: async () => true,
        breakdownGoal: async () => ['a', 'b', 'c'],
        rateBlock: async (_g, text) => {
          calls++;
          if (text.startsWith('w0 ')) throw new Error('timeout');
          return modelOutput(5);
        },
        groupSections: async () => null,
      };
      await g.start(baseStart(a)); // the playhead stays on the failing first block throughout
      await flush();
      const n = g.session!.map.blocks.length;
      expect(calls).toBe(n + 1); // the first block: two attempts; every other block: one
      expect(g.status('A')!.failed).toBe(1);
    });

    it('never changes a completed block\'s rating as mapping continues and sections are grouped', async () => {
      const g = new GoalController();
      const { a, step } = stepAnalyzer({ relevance: (block) => (Number(block.slice(1)) % 3 === 0 ? 9 : 2) });
      const sections: [number, number][] = [];
      a.groupSections = async (_g, _p, first, last) => {
        sections.push([first, last]);
        return [{ from: first, to: last, topic: 'Everything' }];
      };
      await g.start(baseStart(a));
      const map = g.session!.map;
      const n = map.blocks.length;
      await step(); // block 0 done
      const first = { ...map.rating(0)! };
      const firstDecision = g.decide('A', 10, pace);
      for (let i = 1; i < n; i++) await step(); // every other block, then sections
      await flush();
      expect(sections.length).toBeGreaterThan(0);
      expect(map.rating(0)).toEqual(first);
      expect(g.decide('A', 10, pace)).toMatchObject({ kind: 'target', rate: (firstDecision as { rate: number }).rate, label: (firstDecision as { label: string }).label });
    });

    it('names the regions in one batched call, only once every block is done', async () => {
      const g = new GoalController();
      const { a, step, events } = stepAnalyzer({ relevance: (block) => (Number(block.slice(1)) % 3 === 0 ? 9 : 2) });
      const calls: { goal: string; regions: { id: string; topics: string[] }[] }[] = [];
      a.labelRegions = async (goal, regions) => {
        events.push('regions');
        calls.push({ goal, regions });
        return Object.fromEntries(regions.map((r) => [r.id, `Region ${r.id}`]));
      };
      await g.start(baseStart(a));
      const map = g.session!.map;
      const n = map.blocks.length;
      for (let i = 0; i < n - 1; i++) await step();
      expect(calls).toHaveLength(0); // nothing before the map is complete
      expect(g.decide('A', 10, pace).kind).toBe('target'); // and playback didn't wait for it
      await step(); // last block
      await flush();
      expect(calls).toHaveLength(1);
      expect(calls[0]!.goal).toBe(baseStart(a).goal);
      expect(events.filter((e) => e === 'regions')).toHaveLength(1); // never one call per region
      const mapped = goalTimeline(map, pace, 600, 0, false).regions.filter((r) => r.state === 'mapped');
      expect(calls[0]!.regions).toHaveLength(mapped.length); // every final region
      const named = goalTimeline(map, pace, 600, 0, false).regions.filter((r) => r.state === 'mapped');
      expect(named.map((r) => r.name)).toEqual(mapped.map((_, i) => `Region ${i + 1}`));
    });

    it('a failed block does not hold up naming; nothing is named when nothing was rated', async () => {
      const named: string[] = [];
      const mk = (fail: (text: string) => boolean) => {
        const a: GoalAnalyzer = {
          available: async () => true,
          breakdownGoal: async () => ['a', 'b', 'c'],
          rateBlock: async (_g, text) => {
            if (fail(text)) throw new Error('timeout');
            return modelOutput(9);
          },
          labelRegions: async (_g, regions) => {
            named.push(`${regions.length}`);
            return {};
          },
          groupSections: async () => null,
        };
        return a;
      };
      const g = new GoalController();
      await g.start(baseStart(mk((t) => t.startsWith('w0 '))));
      await flush();
      expect(g.status('A')!.failed).toBe(1);
      expect(named).toHaveLength(1);
      const g2 = new GoalController();
      await g2.start(baseStart(mk(() => true)));
      await flush();
      expect(g2.status('A')!.phase).toBe('failed');
      expect(named).toHaveLength(1); // no call for a map with nothing rated
    });

    it('a failed or malformed naming leaves the map, ratings and pacing as they were', async () => {
      for (const labelRegions of [async () => Promise.reject(new Error('timeout')), async () => ({ '999': 'Nope' })]) {
        const g = new GoalController();
        const a = analyzer({ relevance: 8 });
        a.labelRegions = labelRegions as GoalAnalyzer['labelRegions'];
        await g.start(baseStart(a));
        await flush();
        const tl = goalTimeline(g.session!.map, pace, 600, 0, false);
        expect(g.status('A')!.phase).toBe('ready');
        expect(tl.regions.every((r) => r.name === undefined)).toBe(true);
        expect(regionTooltip(tl.regions[0]!).topics).toEqual(['training details']); // block topics, as before
        expect(g.decide('A', 100, pace)).toMatchObject({ kind: 'target', rate: 1.15 });
      }
    });

    it('a late naming answer cannot reach a stopped, restarted or other-video session', async () => {
      let release!: (v: Record<string, string>) => void;
      const a = analyzer({ relevance: 8 });
      a.labelRegions = () => new Promise((r) => (release = r));
      const g = new GoalController();
      await g.start(baseStart(a));
      await flush(); // every block rated; naming in flight
      const old = g.session!;
      await g.start({ ...baseStart(analyzer({ relevance: 2 })), goal: 'A different goal.' }); // edit + Start
      release({ '1': 'Stale name' });
      await flush();
      expect(goalTimeline(old.map, pace, 600, 0, false).regions.every((r) => r.name === undefined)).toBe(true);
      expect(goalTimeline(g.session!.map, pace, 600, 0, false).regions.every((r) => r.name === undefined)).toBe(true);
    });

    it('groups sections only after the blocks, so labels never hold up the map', async () => {
      const g = new GoalController();
      const { a, events, step } = stepAnalyzer({ sections: () => new Promise(() => {}) }); // grouping never answers
      await g.start(baseStart(a));
      const n = g.session!.map.blocks.length;
      for (let i = 0; i < n; i++) await step();
      expect(events.slice(0, n).every((e) => e.startsWith('block'))).toBe(true);
      expect(events.slice(n)).toEqual(['sections']);
      expect(g.session!.map.rated).toBe(n);
      expect(g.status('A')!.phase).toBe('ready'); // ready without waiting for labels
      expect(g.decide('A', 300, pace)).toMatchObject({ kind: 'target', section: null });
    });

    it('ignores late results from a session replaced by a new goal', async () => {
      const g = new GoalController();
      const first = stepAnalyzer({ relevance: () => 10 });
      await g.start(baseStart(first.a));
      await flush();
      const old = g.session!;
      const second = stepAnalyzer({ relevance: () => 0 });
      await g.start({ ...baseStart(second.a), goal: 'Something else entirely.' });
      await first.step(); // the old session's in-flight block finishes now
      expect(old.map.rated).toBe(0);
      expect(g.session).not.toBe(old);
      await second.step();
      expect(g.decide('A', 10, pace)).toMatchObject({ kind: 'target', rate: 2 }); // only the new goal's rating counts
    });
  });

  it('stops on request', async () => {
    const g = new GoalController();
    await g.start(baseStart(analyzer()));
    g.stop();
    expect(g.decide('A', 100, pace)).toEqual({ kind: 'off' });
  });
});
