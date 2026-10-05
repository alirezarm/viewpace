import { describe, expect, it } from 'vitest';
import { ComplexityCache, TransientAiError, type ComplexityProvider } from '../src/content/ai';
import type { ComplexityResult } from '../src/shared/types';

/** Provider whose answers the test resolves by hand, recording the order of requests. */
function manualProvider() {
  const calls: { text: string; resolve: (r: ComplexityResult) => void; reject: (e: unknown) => void }[] = [];
  const provider: ComplexityProvider = {
    name: 'fake',
    status: async () => 'available',
    score: (text) => new Promise((resolve, reject) => calls.push({ text, resolve, reject })),
  };
  return { provider, calls };
}
const result = (raw: number): ComplexityResult => ({ raw, score: raw / 10, label: '', latencyMs: 1 });
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('AI request queue', () => {
  it('has one request in flight and serves the most urgent chunk next', async () => {
    const { provider, calls } = manualProvider();
    const cache = new ComplexityCache(provider);
    cache.request('v:5', 5, 'five');
    cache.request('v:7', 7, 'seven');
    cache.request('v:6', 6, 'six');
    expect(calls.map((c) => c.text)).toEqual(['five']);
    calls[0]!.resolve(result(5));
    await flush();
    expect(calls.map((c) => c.text)).toEqual(['five', 'six']);
  });

  it('drops queued chunks the playhead has passed (e.g. after a seek)', async () => {
    const { provider, calls } = manualProvider();
    const cache = new ComplexityCache(provider);
    cache.request('v:1', 1, 'one');
    cache.request('v:2', 2, 'two');
    cache.request('v:3', 3, 'three');
    cache.setPlayhead(30); // seeked far ahead
    cache.request('v:30', 30, 'thirty');
    calls[0]!.resolve(result(1));
    await flush();
    expect(calls.map((c) => c.text)).toEqual(['one', 'thirty']);
  });

  it('does not count lost messages (worker restart) as model failures', async () => {
    const { provider, calls } = manualProvider();
    const cache = new ComplexityCache(provider);
    for (let i = 0; i < 6; i++) {
      cache.request(`v:${i}`, i, `t${i}`);
      calls[i]!.reject(new TransientAiError('message port closed'));
      await flush();
    }
    cache.request('v:9', 9, 'still trying');
    expect(calls.at(-1)!.text).toBe('still trying');
  });

  it('stops after repeated real model errors', async () => {
    const { provider, calls } = manualProvider();
    const cache = new ComplexityCache(provider);
    for (let i = 0; i < 5; i++) {
      cache.request(`v:${i}`, i, `t${i}`);
      calls[i]!.reject(new Error('model error'));
      await flush();
    }
    cache.request('v:9', 9, 'ignored');
    expect(calls).toHaveLength(5);
  });
});
