import { beforeEach, describe, expect, it } from 'vitest';
import { appendDecision, feedbackOnlyEntry, readLog } from '../src/shared/log';
import type { DecisionLogEntry } from '../src/shared/types';

const decision: DecisionLogEntry = {
  id: 'd1', timestamp: 1, videoId: 'v', videoTime: 12, chunk: 'secret transcript words',
  features: null, aiScore: 7, aiLabel: 'explains the plot twist', aiMean: 5, previousRate: 1.2,
  selectedRate: 1.4, targetRate: 1.4, changed: true, mode: 'ai', profile: 'normal', reason: '160 wpm',
  transcriptSource: 'player-track', feedback: null, feedbackAt: null,
};

beforeEach(() => {
  const mem: Record<string, unknown> = {};
  (globalThis as { chrome?: unknown }).chrome = {
    storage: { local: { get: async (k: string) => ({ [k]: mem[k] }), set: async (o: object) => Object.assign(mem, o) } },
  };
});

describe('Lightweight feedback log', () => {
  it('keeps the numbers but no transcript text', () => {
    const e = feedbackOnlyEntry(decision, 'too_fast', 99);
    expect(e).toMatchObject({ kind: 'feedback', feedback: 'too_fast', feedbackAt: 99, aiScore: 7, selectedRate: 1.4 });
    expect(e.chunk).toBe('');
    expect(e.aiLabel).toBeNull();
    expect(e.id).not.toBe(decision.id);
  });

  it('stays within its size bound', async () => {
    for (let i = 0; i < 7; i++) await appendDecision({ ...decision, id: `d${i}` }, 5);
    const log = await readLog();
    expect(log.map((e) => e.id)).toEqual(['d2', 'd3', 'd4', 'd5', 'd6']);
  });
});
