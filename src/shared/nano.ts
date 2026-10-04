/** Gemini Nano via Chrome's Prompt API. Usable from any extension *window* context (not workers). */
import type { AiAvailability, ComplexityResult } from './types';
import { RESPONSE_SCHEMA, SYSTEM_PROMPT, buildUserPrompt, parseComplexity, type ChunkContext } from './complexity-prompt';

export const LANGUAGE_OPTIONS = {
  expectedInputs: [{ type: 'text', languages: ['en'] }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }],
} satisfies Pick<LanguageModelCreateOptions, 'expectedInputs' | 'expectedOutputs'>;

export function getLanguageModel(): LanguageModelStatic | undefined {
  return (globalThis as { LanguageModel?: LanguageModelStatic }).LanguageModel;
}

export async function nanoAvailability(): Promise<AiAvailability> {
  const LM = getLanguageModel();
  if (!LM) return 'unsupported';
  try {
    return await LM.availability(LANGUAGE_OPTIONS);
  } catch {
    return 'error';
  }
}

const SCORE_TIMEOUT_MS = 10000;

export class NanoComplexityEngine {
  private base: Promise<LanguageModelSession> | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  private async baseSession(): Promise<LanguageModelSession> {
    const LM = getLanguageModel();
    if (!LM) throw new Error('Prompt API not present in this Chrome');
    if (!this.base) {
      const opts: LanguageModelCreateOptions = {
        ...LANGUAGE_OPTIONS,
        initialPrompts: [{ role: 'system', content: SYSTEM_PROMPT }],
      };
      // Low temperature for repeatable scores; extensions may set sampling params (both are required together).
      const create = async () => {
        try {
          const p = await LM.params?.();
          if (p) return await LM.create({ ...opts, temperature: Math.min(0.2, p.maxTemperature), topK: Math.min(3, p.maxTopK) });
        } catch {
          /* fall through */
        }
        return LM.create(opts);
      };
      this.base = create();
      this.base.catch(() => (this.base = null));
    }
    return this.base;
  }

  /** Scores are serialized: one on-device inference at a time. */
  score(chunk: string, context?: ChunkContext): Promise<ComplexityResult> {
    const run = async (): Promise<ComplexityResult> => {
      const t0 = performance.now();
      const base = await this.baseSession();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SCORE_TIMEOUT_MS);
      // Clone per prompt so earlier excerpts don't accumulate in context or bias later scores.
      const session = await base.clone({ signal: controller.signal });
      try {
        const out = await session.prompt(buildUserPrompt(chunk, context), {
          responseConstraint: RESPONSE_SCHEMA,
          signal: controller.signal,
        });
        const parsed = parseComplexity(out);
        return { ...parsed, latencyMs: Math.round(performance.now() - t0) };
      } finally {
        clearTimeout(timer);
        session.destroy();
      }
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }
}
