/**
 * Evaluation-only page script (not part of the extension build or release).
 *
 * Runs the REAL Goal Mode analysis on a captured caption track: production caption parsing,
 * production blocking, the production GoalSession (ordering, retry, section grouping) and the
 * production NanoGoalAnalyzer, whose requests are answered by the real background service
 * worker (NanoPrompter, prompts, schemas, validation). The only addition is a wrapper around the
 * analyzer that records each model call's timing and outcome.
 */
import { NanoGoalAnalyzer, NanoProvider } from '../../src/content/ai';
import { transcriptFromTimedtext } from '../../src/content/captions';
import { PROFILES } from '../../src/content/controller';
import { makeBlocks } from '../../src/content/goal/blocks';
import { goalTarget } from '../../src/content/goal/goal-pacing';
import { GoalSession, type GoalAnalyzer } from '../../src/content/goal/goal-session';

interface CallRecord {
  type: 'block' | 'sections';
  blockText?: string;
  context?: string; // rolling context sent with the block (POC 1.4)
  startMs: number;
  endMs: number;
  ok: boolean;
  error?: string;
  sectionsValid?: boolean;
}

interface RunState {
  status: 'running' | 'done' | 'error';
  result?: unknown;
  error?: string;
}

const runs: Record<string, RunState> = {};

async function runGoalEval(key: string, capture: { url: string; body: string }, goal: string, title: string): Promise<void> {
  const transcript = transcriptFromTimedtext(capture.url, capture.body);
  if (!transcript) throw new Error('could not parse transcript');
  const end = Math.max(...transcript.cues.map((c) => c.end), transcript.words.at(-1)?.t ?? 0);
  const blocks = makeBlocks(transcript.words, end);

  const real = new NanoGoalAnalyzer(new NanoProvider());
  const calls: CallRecord[] = [];
  let t0 = 0;
  const now = () => performance.now() - t0;
  const analyzer: GoalAnalyzer = {
    available: () => real.available(),
    rateBlock: async (g, text, ttl, context) => {
      const startMs = now();
      try {
        const r = await real.rateBlock(g, text, ttl, context);
        calls.push({ type: 'block', blockText: text, context, startMs, endMs: now(), ok: true });
        return r;
      } catch (e) {
        calls.push({ type: 'block', blockText: text, context, startMs, endMs: now(), ok: false, error: e instanceof Error ? e.message : String(e) });
        throw e;
      }
    },
    groupSections: async (g, parts, first, last) => {
      const startMs = now();
      try {
        const s = await real.groupSections(g, parts, first, last);
        calls.push({ type: 'sections', startMs, endMs: now(), ok: true, sectionsValid: s !== null });
        return s;
      } catch (e) {
        calls.push({ type: 'sections', startMs, endMs: now(), ok: false, error: e instanceof Error ? e.message : String(e) });
        throw e;
      }
    },
  };

  const available = await real.available();
  const session = new GoalSession('eval', goal, blocks);
  t0 = performance.now();
  if (available) await session.run(analyzer, { isCurrent: () => true, startAt: 0, title });
  const totalMs = now();

  const pace = PROFILES.normal;
  const rows = blocks.map((b) => {
    const r = session.map.rating(b.index);
    const target = r ? goalTarget(r, pace) : null;
    const blockCalls = calls.filter((c) => c.type === 'block' && c.blockText === b.text);
    const okCall = blockCalls.find((c) => c.ok);
    return {
      index: b.index,
      start: b.start,
      end: b.end,
      text: b.text,
      topic: r?.topic ?? null,
      relevance: r?.relevance ?? null,
      relevanceCategory: (r as { relevanceCategory?: string } | undefined)?.relevanceCategory ?? null, // only the POC 1.3A categorical scorer set this
      attention: r?.attention ?? null,
      reason: r?.reason ?? null,
      contextIn: okCall ? (okCall.context ?? '') : null, // notes this block was rated with (POC 1.4)
      rollingContext: r?.rollingContext ?? null, // notes it returned for the next block (POC 1.4)
      category: target?.label ?? null,
      targetRate: target ? Number(target.rate.toFixed(3)) : null,
      calls: blockCalls.length,
      ratedAtMs: okCall ? Math.round(okCall.endMs) : null,
    };
  });

  runs[key] = {
    status: 'done',
    result: {
      goal,
      title,
      available,
      phase: session.phase,
      pace: 'normal',
      transcript: { lang: transcript.lang, kind: transcript.kind || 'uploaded', timing: transcript.timing, words: transcript.words.length, endSec: end },
      totalMs: Math.round(totalMs),
      calls: calls.map(({ blockText, context, ...c }) => ({ ...c, startMs: Math.round(c.startMs), endMs: Math.round(c.endMs), blockChars: blockText?.length, contextChars: context?.length ?? 0 })),
      blocks: rows,
      sections: session.map.sections(),
    },
  };
}

// Started without awaiting; the harness polls `goalEvalStatus` and then reads `goalEvalResult`.
Object.assign(window, {
  startGoalEval(key: string, capture: { url: string; body: string }, goal: string, title: string) {
    runs[key] = { status: 'running' };
    runGoalEval(key, capture, goal, title).catch((e: unknown) => {
      runs[key] = { status: 'error', error: e instanceof Error ? e.message : String(e) };
    });
    return 'started';
  },
  goalEvalStatus: (key: string) => runs[key]?.status ?? 'missing',
  goalEvalResult: (key: string) => runs[key],
  /**
   * Token counts for the POC 1.4 cost comparison, measured after the runs (not part of the scoring):
   * Nano's own tokenizer on each text. Returns null where this Chrome can't measure.
   */
  async measureTokens(texts: string[]): Promise<(number | null)[]> {
    const LM = (globalThis as { LanguageModel?: LanguageModelStatic }).LanguageModel;
    if (!LM) return texts.map(() => null);
    const session = await LM.create({ expectedInputs: [{ type: 'text', languages: ['en'] }], expectedOutputs: [{ type: 'text', languages: ['en'] }] });
    const measure = session.measureContextUsage ?? session.measureInputUsage;
    try {
      const out: (number | null)[] = [];
      for (const t of texts) out.push(measure ? await measure.call(session, t) : null);
      return out;
    } finally {
      session.destroy();
    }
  },
});
