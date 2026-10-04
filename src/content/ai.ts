import type { AiRequest, AiResponse } from '../shared/messages';
import type { AiAvailability, ComplexityResult } from '../shared/types';

/** Anything that can turn a transcript chunk into a constrained 0..1 complexity score. */
export interface ComplexityProvider {
  readonly name: string;
  status(): Promise<AiAvailability>;
  score(text: string): Promise<ComplexityResult>;
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

/** Gemini Nano, running in the extension's offscreen document (via the service worker). */
export class NanoProvider implements ComplexityProvider {
  readonly name = 'gemini-nano';

  private async send(req: AiRequest): Promise<AiResponse> {
    return (await chrome.runtime.sendMessage(req)) as AiResponse;
  }

  async status(): Promise<AiAvailability> {
    try {
      const r = await this.send({ kind: 'ai:status' });
      return r.ok && 'status' in r ? r.status : 'error';
    } catch {
      return 'error';
    }
  }

  async score(text: string): Promise<ComplexityResult> {
    const r = await this.send({ kind: 'ai:score', text });
    if (r.ok && 'result' in r) return r.result;
    throw new Error(r.ok ? 'unexpected response' : r.error);
  }
}

/**
 * Caches scores per transcript chunk and fetches ahead, so the control loop never waits on
 * inference: it uses whatever score is ready and otherwise falls back to speech features.
 */
export class ComplexityCache {
  private results = new Map<string, ComplexityResult>();
  private inflight = new Set<string>();
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
    this.inflight.clear();
    this.failures = 0;
    this.generation++;
  }

  get(key: string): ComplexityResult | null {
    return this.results.get(key) ?? null;
  }

  request(key: string, text: string): void {
    if (this.results.has(key) || this.inflight.has(key) || !text.trim()) return;
    if (this.failures >= 5) return; // stop hammering a broken provider; cleared on video change
    this.inflight.add(key);
    const gen = this.generation;
    this.provider
      .score(text)
      .then((r) => {
        if (gen !== this.generation) return;
        this.results.set(key, r);
        this.failures = 0;
        this.lastError = null;
      })
      .catch((e: unknown) => {
        if (gen !== this.generation) return;
        this.failures++;
        this.lastError = e instanceof Error ? e.message : String(e);
      })
      .finally(() => {
        if (gen === this.generation) this.inflight.delete(key);
      });
  }

  /** All scores (0..1) computed so far for the current video. */
  scores(): number[] {
    return Array.from(this.results.values(), (r) => r.score);
  }

  get pending(): number {
    return this.inflight.size;
  }
}
