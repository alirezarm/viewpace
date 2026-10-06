/**
 * Gemini Nano via Chrome's Prompt API. Usable from extension pages and the extension service
 * worker (Chrome enables the API for workers only in extension processes).
 */
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

/**
 * Download/set up Gemini Nano. Must be called from a user gesture (popup or overlay click);
 * the model is shared browser-wide, so the service worker can use it afterwards.
 * `onProgress` receives the download fraction 0..1. Throws if the Prompt API is missing or
 * the download fails.
 */
export async function downloadNanoModel(onProgress?: (fraction: number) => void): Promise<void> {
  const LM = getLanguageModel();
  if (!LM) throw new Error('Prompt API not available in this context');
  const session = await LM.create({
    ...LANGUAGE_OPTIONS,
    monitor(m) {
      m.addEventListener('downloadprogress', (e) => onProgress?.((e as ProgressEvent).loaded ?? 0));
    },
  });
  session.destroy();
}

const SCORE_TIMEOUT_MS = 10000;

/** The prompt (with its schema) would not fit the model's context window. */
export class PromptTooLargeError extends Error {}

/**
 * Prompts Gemini Nano with a JSON-schema-constrained answer. One base session per system prompt
 * (created lazily, re-created after a service-worker restart), cloned per prompt so earlier
 * prompts never accumulate in context. All prompts share one queue: one on-device inference at a
 * time, whichever feature asks.
 */
export class NanoPrompter {
  private bases = new Map<string, Promise<LanguageModelSession>>();
  private chain: Promise<unknown> = Promise.resolve();

  private baseSession(systemPrompt: string): Promise<LanguageModelSession> {
    const LM = getLanguageModel();
    if (!LM) return Promise.reject(new Error('Prompt API not present in this Chrome'));
    let base = this.bases.get(systemPrompt);
    if (!base) {
      const opts: LanguageModelCreateOptions = {
        ...LANGUAGE_OPTIONS,
        initialPrompts: [{ role: 'system', content: systemPrompt }],
      };
      // Low temperature for repeatable answers; extensions may set sampling params (both are required together).
      const create = async () => {
        try {
          const p = await LM.params?.();
          if (p) return await LM.create({ ...opts, temperature: Math.min(0.2, p.maxTemperature), topK: Math.min(3, p.maxTopK) });
        } catch {
          /* fall through */
        }
        return LM.create(opts);
      };
      base = create();
      base.catch(() => this.bases.delete(systemPrompt));
      this.bases.set(systemPrompt, base);
    }
    return base;
  }

  /** Resolves with the model's raw (schema-constrained) text. */
  prompt(systemPrompt: string, userPrompt: string, schema: object, timeoutMs = SCORE_TIMEOUT_MS): Promise<string> {
    const run = async (): Promise<string> => {
      const base = await this.baseSession(systemPrompt);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let session: LanguageModelSession;
      try {
        session = await base.clone({ signal: controller.signal });
      } catch (e) {
        clearTimeout(timer);
        this.bases.delete(systemPrompt); // base session unusable (e.g. destroyed by Chrome): re-create next time
        throw e;
      }
      try {
        await assertFits(session, userPrompt, schema);
        return await session.prompt(userPrompt, { responseConstraint: schema, signal: controller.signal });
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

/**
 * Refuse prompts that would overflow the context window (which would otherwise silently drop
 * earlier context, including the instructions). Uses whichever measuring API this Chrome offers;
 * if none, relies on the callers' own size caps.
 */
async function assertFits(session: LanguageModelSession, userPrompt: string, schema: object): Promise<void> {
  const window = session.contextWindow ?? session.inputQuota;
  const used = session.contextUsage ?? session.inputUsage ?? 0;
  const measure = session.measureContextUsage ?? session.measureInputUsage;
  if (!window || !measure) return;
  const needed = await measure.call(session, userPrompt, { responseConstraint: schema });
  if (used + needed > window * 0.9) throw new PromptTooLargeError(`prompt needs ${needed} of ${window - used} tokens left`);
}

export class NanoComplexityEngine {
  constructor(private prompter: NanoPrompter) {}

  /** Smart Pacing: score one transcript chunk (shares the prompter's queue). */
  async score(chunk: string, context?: ChunkContext): Promise<ComplexityResult> {
    const t0 = performance.now();
    const out = await this.prompter.prompt(SYSTEM_PROMPT, buildUserPrompt(chunk, context), RESPONSE_SCHEMA);
    return { ...parseComplexity(out), latencyMs: Math.round(performance.now() - t0) };
  }
}
