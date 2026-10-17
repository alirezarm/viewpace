import type { ChunkContext } from '../shared/complexity-prompt';
import type { BlockRating, PartSummary, RegionTopics, SectionRange } from '../shared/goal-prompt';
import type { AiRequest, AiResponse } from '../shared/messages';
import type { GoalAnalyzer } from './goal/goal-session';
import type { AiAvailability, ComplexityResult } from '../shared/types';

/** Anything that can turn a transcript chunk into a constrained 0..1 complexity score. */
export interface ComplexityProvider {
  readonly name: string;
  status(): Promise<AiAvailability>;
  score(text: string, context?: ChunkContext): Promise<ComplexityResult>;
}

export class DisabledProvider implements ComplexityProvider {
  readonly name = 'none';
  async status(): Promise<AiAvailability> {
    return 'disabled';
  }
  async score(): Promise<ComplexityResult> {
    throw new Error('AI provider disabled');
  }
}

/**
 * The request never reached the model or its answer was lost (e.g. Chrome stopped and restarted
 * the extension's background worker). Worth retrying; not a sign the model is broken.
 */
export class TransientAiError extends Error {}

/** Gemini Nano, running in the extension service worker. */
export class NanoProvider implements ComplexityProvider {
  readonly name = 'gemini-nano';

  private async send(req: AiRequest): Promise<AiResponse> {
    try {
      return (await chrome.runtime.sendMessage(req)) as AiResponse;
    } catch (e) {
      throw new TransientAiError(e instanceof Error ? e.message : String(e));
    }
  }

  async status(): Promise<AiAvailability> {
    try {
      const r = await this.send({ kind: 'ai:status' });
      return r.ok && 'status' in r ? r.status : 'error';
    } catch {
      return 'error';
    }
  }

  async score(text: string, context?: ChunkContext): Promise<ComplexityResult> {
    const r = await this.send({ kind: 'ai:score', text, context });
    if (r.ok && 'result' in r) return r.result;
    throw new Error(r.ok ? 'unexpected response' : r.error);
  }
}

/** Goal Mode analysis via Gemini Nano in the extension service worker. */
export class NanoGoalAnalyzer implements GoalAnalyzer {
  constructor(private nano: NanoProvider) {}

  async available(): Promise<boolean> {
    return (await this.nano.status()) === 'available';
  }

  async breakdownGoal(goal: string): Promise<string[]> {
    const r = (await chrome.runtime.sendMessage({ kind: 'ai:goal-breakdown', goal } satisfies AiRequest)) as AiResponse;
    if (r.ok && 'needs' in r) return r.needs;
    throw new Error(r.ok ? 'unexpected response' : r.error);
  }

  async rateBlock(goal: string, text: string, title?: string, needs?: string[] | null): Promise<BlockRating> {
    const r = (await chrome.runtime.sendMessage({ kind: 'ai:goal-block', goal, text, title, needs } satisfies AiRequest)) as AiResponse;
    if (r.ok && 'goalBlock' in r) return r.goalBlock;
    throw new Error(r.ok ? 'unexpected response' : r.error);
  }

  async labelRegions(goal: string, regions: RegionTopics[]): Promise<Record<string, string>> {
    const r = (await chrome.runtime.sendMessage({ kind: 'ai:goal-regions', goal, regions } satisfies AiRequest)) as AiResponse;
    if (r.ok && 'regionLabels' in r) return r.regionLabels;
    throw new Error(r.ok ? 'unexpected response' : r.error);
  }

  async groupSections(goal: string, parts: PartSummary[], first: number, last: number): Promise<SectionRange[] | null> {
    const r = (await chrome.runtime.sendMessage({ kind: 'ai:goal-sections', goal, parts, first, last } satisfies AiRequest)) as AiResponse;
    if (r.ok && 'sections' in r) return r.sections;
    return null;
  }
}

interface QueuedChunk {
  index: number;
  text: string;
  context?: ChunkContext;
}

/**
 * Caches scores per transcript chunk and fetches ahead, so the control loop never waits on
 * inference: it uses whatever score is ready and otherwise falls back to speech features.
 * Only one request is in flight at a time, always the most urgent chunk at or after the playhead;
 * chunks the playhead has passed are dropped instead of being scored late.
 */
export class ComplexityCache {
  private results = new Map<string, { index: number; result: ComplexityResult }>();
  private queue = new Map<string, QueuedChunk>();
  private inflight: string | null = null;
  private playhead = -Infinity;
  private failures = 0;
  private generation = 0;
  lastError: string | null = null;

  constructor(private provider: ComplexityProvider) {}

  setProvider(p: ComplexityProvider): void {
    this.provider = p;
    this.clear();
  }

  clear(): void {
    this.results.clear();
    this.queue.clear();
    this.inflight = null;
    this.failures = 0;
    this.generation++;
  }

  get(key: string): ComplexityResult | null {
    return this.results.get(key)?.result ?? null;
  }

  /** Chunk index currently playing. Queued chunks before it are no longer useful. */
  setPlayhead(index: number): void {
    this.playhead = index;
    for (const [key, c] of this.queue) if (c.index < index) this.queue.delete(key);
    this.pump();
  }

  /** `index` is the chunk's position on the video timeline (used to order scores). */
  request(key: string, index: number, text: string, context?: ChunkContext): void {
    if (this.results.has(key) || this.inflight === key || this.queue.has(key) || !text.trim()) return;
    if (this.failures >= 5) return; // stop hammering a broken provider; cleared on video change
    if (index < this.playhead) return;
    this.queue.set(key, { index, text, context });
    this.pump();
  }

  private pump(): void {
    if (this.inflight !== null || this.queue.size === 0) return;
    let next: [string, QueuedChunk] | null = null;
    for (const entry of this.queue) if (!next || entry[1].index < next[1].index) next = entry;
    const [key, chunk] = next!;
    this.queue.delete(key);
    this.inflight = key;
    const gen = this.generation;
    this.provider
      .score(chunk.text, chunk.context)
      .then((r) => {
        if (gen !== this.generation) return;
        this.results.set(key, { index: chunk.index, result: r });
        this.failures = 0;
        this.lastError = null;
      })
      .catch((e: unknown) => {
        if (gen !== this.generation) return;
        this.lastError = e instanceof Error ? e.message : String(e);
        // Lost messages are retried by the next request(); only real model errors count.
        if (!(e instanceof TransientAiError)) this.failures++;
      })
      .finally(() => {
        if (gen !== this.generation) return;
        this.inflight = null;
        this.pump();
      });
  }

  /** Scores (0..1) of chunks up to and including `index`, in timeline order (no peeking ahead). */
  scoresUpTo(index: number): number[] {
    return Array.from(this.results.values())
      .filter((e) => e.index <= index)
      .sort((a, b) => a.index - b.index)
      .map((e) => e.result.score);
  }

  get pending(): number {
    return this.queue.size + (this.inflight ? 1 : 0);
  }
}
