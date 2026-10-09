/**
 * Evaluation-only (POC 1.5): the fixed goal breakdown each run used, and per-block cost against
 * POC 1.1 and POC 1.4.
 *
 *   npx esbuild eval/goal-mode/breakdown-metrics.ts --bundle --platform=node --format=esm --outfile=/tmp/bm.mjs
 *   EVAL_NEW=eval-results/goal-mode-poc1.5 [EVAL_EXT_ID=<id> EVAL_PORT=9333] node /tmp/bm.mjs
 *
 * With EVAL_EXT_ID (eval page open), token counts come from Nano's own tokenizer (`measureTokens`),
 * measured after the runs. POC 1.4's token counts are read from its context.json (same method).
 * Writes $EVAL_NEW/breakdown.{json,md}. Nothing here feeds back into Goal Mode.
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { BLOCK_SYSTEM_PROMPT, BLOCK_SYSTEM_PROMPT_WITH_NEEDS, BREAKDOWN_SYSTEM_PROMPT, buildBlockPrompt, buildBreakdownPrompt } from '../../src/shared/goal-prompt';

const BASE = 'eval-results/goal-mode-poc1';
const ROLLING = 'eval-results/goal-mode-poc1.4';
const NEW = process.env.EVAL_NEW ?? 'eval-results/goal-mode-poc1.5';
const GOALS = ['A', 'B', 'C'] as const;

interface Block {
  index: number;
  text: string;
  topic: string | null;
  relevance: number | null;
  attention: number | null;
  reason: string | null;
  calls: number;
}
interface Call {
  type: string;
  startMs: number;
  endMs: number;
  ok: boolean;
  error?: string;
}
interface Run {
  goal: string;
  title: string;
  totalMs: number;
  needs?: string[] | null;
  calls: Call[];
  blocks: Block[];
}
const videos: { video: string; title: string }[] = JSON.parse(readFileSync('eval/goal-mode/goals.json', 'utf8'));
const keys = videos.flatMap((v) => GOALS.map((g) => ({ video: v.video, title: v.title, key: `${v.video}-${g}` })));
const load = (dir: string, key: string): Run => JSON.parse(readFileSync(`${dir}/runs/${key}.json`, 'utf8')).result;

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const r2 = (x: number) => Math.round(x * 100) / 100;
const pctl = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : 0;
};

// ---------- the breakdowns ----------
const breakdowns = keys.map(({ key }) => {
  const run = load(NEW, key);
  const call = run.calls.find((c) => c.type === 'breakdown');
  return { key, goal: run.goal, needs: run.needs ?? null, ok: call?.ok ?? false, error: call?.error, ms: call ? Math.round(call.endMs - call.startMs) : null };
});

// ---------- latency and failures ----------
const callStats = (dir: string) => {
  const durs: number[] = [];
  const totals: number[] = [];
  const firstDecision: number[] = [];
  let retries = 0;
  let unmapped = 0;
  let failedCalls = 0;
  let timeouts = 0;
  for (const { key } of keys) {
    const run = load(dir, key);
    for (const c of run.calls) {
      if (c.type !== 'block') continue;
      durs.push(c.endMs - c.startMs);
      if (!c.ok) failedCalls++;
      if (!c.ok && /abort/i.test(c.error ?? '')) timeouts++;
    }
    totals.push(run.totalMs);
    const firstOk = run.calls.find((c) => c.type === 'block' && c.ok);
    if (firstOk) firstDecision.push(firstOk.endMs);
    retries += run.blocks.reduce((a, b) => a + Math.max(0, b.calls - 1), 0);
    unmapped += run.blocks.filter((b) => b.relevance === null).length;
  }
  return {
    blockCalls: durs.length,
    callMedianS: r2(pctl(durs, 0.5) / 1000),
    callMeanS: r2(mean(durs) / 1000),
    callP90S: r2(pctl(durs, 0.9) / 1000),
    firstDecisionS: r2(mean(firstDecision) / 1000),
    runTotalMeanS: r2(mean(totals) / 1000),
    retries,
    failedCalls,
    timeouts,
    unmapped,
  };
};
const latency = { base: callStats(BASE), rolling: callStats(ROLLING), neu: callStats(NEW) };

// ---------- tokens (Nano's tokenizer, via the eval page) ----------
async function measure(texts: string[]): Promise<(number | null)[] | null> {
  const ext = process.env.EVAL_EXT_ID;
  if (!ext) return null;
  const port = process.env.EVAL_PORT ?? '9333';
  const page = `chrome-extension://${ext}/eval.html`;
  const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { url: string; type: string; webSocketDebuggerUrl: string }[];
  const t = list.find((x) => x.type === 'page' && x.url === page);
  if (!t) throw new Error(`open ${page} first`);
  const out: (number | null)[] = [];
  for (let i = 0; i < texts.length; i += 100) {
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    const part = await new Promise<(number | null)[]>((resolve, reject) => {
      ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data));
        if (m.id !== 1) return;
        if (m.error || m.result?.exceptionDetails) reject(new Error(JSON.stringify(m.error ?? m.result.exceptionDetails)));
        else resolve(m.result.result.value);
      };
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: `measureTokens(${JSON.stringify(texts.slice(i, i + 100))})`, awaitPromise: true, returnByValue: true } }));
    });
    ws.close();
    out.push(...part);
  }
  return out;
}

const texts: { kind: string; text: string }[] = [
  { kind: 'system-base', text: BLOCK_SYSTEM_PROMPT },
  { kind: 'system-new', text: BLOCK_SYSTEM_PROMPT_WITH_NEEDS },
  { kind: 'system-breakdown', text: BREAKDOWN_SYSTEM_PROMPT },
];
for (const { key, title } of keys) {
  const base = load(BASE, key);
  const neu = load(NEW, key);
  texts.push({ kind: 'breakdown-in', text: buildBreakdownPrompt(neu.goal) });
  if (neu.needs) texts.push({ kind: 'breakdown-out', text: JSON.stringify({ needs: neu.needs }) });
  for (const b of base.blocks) {
    if (b.relevance === null) continue;
    texts.push({ kind: 'in-base', text: buildBlockPrompt(base.goal, b.text, title) });
    texts.push({ kind: 'out-base', text: JSON.stringify({ topic: b.topic, relevance: b.relevance, attention: b.attention, reason: b.reason }) });
  }
  for (const b of neu.blocks) {
    if (b.relevance === null) continue;
    texts.push({ kind: 'in-new', text: buildBlockPrompt(neu.goal, b.text, title, neu.needs) });
    texts.push({ kind: 'out-new', text: JSON.stringify({ topic: b.topic, relevance: b.relevance, attention: b.attention, reason: b.reason }) });
  }
}
// The POC 1.1 prompt is unchanged in this build; check it really is POC 1.1's before counting it as the baseline.
const oldPrompt = execSync('git show 1b69f3a:src/shared/goal-prompt.ts', { encoding: 'utf8' }).match(/BLOCK_SYSTEM_PROMPT = `([^`]*)`/)![1]!;
if (oldPrompt !== BLOCK_SYSTEM_PROMPT) throw new Error('BLOCK_SYSTEM_PROMPT differs from POC 1.1');

const counts = await measure(texts.map((t) => t.text));
const tokens = counts
  ? (() => {
      const by = (k: string) => counts.filter((_, i) => texts[i]!.kind === k).filter((x): x is number => x !== null);
      const s = (k: string) => ({ mean: r2(mean(by(k))), p90: pctl(by(k), 0.9), max: by(k).length ? Math.max(...by(k)) : 0 });
      return {
        systemBase: by('system-base')[0],
        systemNew: by('system-new')[0],
        systemBreakdown: by('system-breakdown')[0],
        breakdownIn: s('breakdown-in'),
        breakdownOut: s('breakdown-out'),
        inBase: s('in-base'),
        inNew: s('in-new'),
        outBase: s('out-base'),
        outNew: s('out-new'),
      };
    })()
  : null;
const rollingTokens = JSON.parse(readFileSync(`${ROLLING}/context.json`, 'utf8')).tokens;

writeFileSync(`${NEW}/breakdown.json`, JSON.stringify({ breakdowns, latency, tokens, rollingTokens }, null, 1));

const md: string[] = ['# POC 1.5 fixed goal breakdown: the breakdowns and their cost (generated by eval/goal-mode/breakdown-metrics.ts)', ''];
for (const b of breakdowns) {
  md.push(`**${b.key}**: ${b.goal}`, '');
  if (b.needs) for (const n of b.needs) md.push(`- ${n}`);
  else md.push(`- (no breakdown: ${b.error ?? 'failed'}; scored as POC 1.1)`);
  md.push('', `Breakdown call: ${b.ms} ms`, '');
}
md.push('| Cost | POC 1.1 | POC 1.4 | POC 1.5 |', '|---|---|---|---|');
for (const k of ['blockCalls', 'callMedianS', 'callMeanS', 'callP90S', 'firstDecisionS', 'runTotalMeanS', 'retries', 'failedCalls', 'timeouts', 'unmapped'] as const)
  md.push(`| ${k} | ${latency.base[k]} | ${latency.rolling[k]} | ${latency.neu[k]} |`);
if (tokens) {
  const f = (x: { mean: number; p90: number; max: number }) => `${x.mean} (${x.p90}, ${x.max})`;
  md.push(`| block system prompt tokens | ${tokens.systemBase} | ${rollingTokens.systemNew} | ${tokens.systemNew} |`);
  md.push(`| input tokens/block mean (p90, max) | ${f(tokens.inBase)} | ${f(rollingTokens.inNew)} | ${f(tokens.inNew)} |`);
  md.push(`| output tokens/block mean (p90, max) | ${f(tokens.outBase)} | ${f(rollingTokens.outNew)} | ${f(tokens.outNew)} |`);
  md.push(`| one-off breakdown call: system / input / output tokens | – | – | ${tokens.systemBreakdown} / ${tokens.breakdownIn.mean} / ${tokens.breakdownOut.mean} |`);
}
writeFileSync(`${NEW}/breakdown.md`, md.join('\n') + '\n');
console.log(md.join('\n'));
