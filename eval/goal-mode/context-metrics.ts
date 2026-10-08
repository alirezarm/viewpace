/**
 * Evaluation-only (POC 1.4): what the rolling context looks like, and what it costs per block,
 * against the POC 1.1 baseline runs.
 *
 *   npx esbuild eval/goal-mode/context-metrics.ts --bundle --platform=node --format=esm --outfile=/tmp/cm.mjs
 *   EVAL_NEW=eval-results/goal-mode-poc1.4 [EVAL_EXT_ID=<id> EVAL_PORT=9333] node /tmp/cm.mjs
 *
 * With EVAL_EXT_ID, token counts come from Nano's own tokenizer (`measureTokens` on the eval page of
 * that extension, run after the evaluation so it can't slow it down); without it they are omitted.
 * Writes $EVAL_NEW/context.{json,md}. Nothing here feeds back into Goal Mode.
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { BLOCK_SYSTEM_PROMPT, MAX_CONTEXT_CHARS, buildBlockPrompt } from '../../src/shared/goal-prompt';

const BASE = 'eval-results/goal-mode-poc1';
const NEW = process.env.EVAL_NEW ?? 'eval-results/goal-mode-poc1.4';
const GOALS = ['A', 'B', 'C'] as const;

interface Block {
  index: number;
  text: string;
  topic: string | null;
  relevance: number | null;
  attention: number | null;
  reason: string | null;
  contextIn?: string | null;
  rollingContext?: string | null;
  calls: number;
}
interface Run {
  goal: string;
  title: string;
  totalMs: number;
  calls: { type: string; startMs: number; endMs: number; ok: boolean }[];
  blocks: Block[];
}
const videos: { video: string; title: string }[] = JSON.parse(readFileSync('eval/goal-mode/goals.json', 'utf8'));
const load = (dir: string, key: string): Run => JSON.parse(readFileSync(`${dir}/runs/${key}.json`, 'utf8')).result;
const judge = Object.fromEntries(
  videos.map((v) => [v.video, (JSON.parse(readFileSync(`${BASE}/judge/${v.video}.judge.json`, 'utf8')) as { scores: { index: number; A: number; B: number; C: number }[] }).scores]),
);

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const r2 = (x: number) => Math.round(x * 100) / 100;
const pctl = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : 0;
};
const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]+/g) ?? []);
const jaccard = (a: Set<string>, b: Set<string>) => {
  const inter = [...a].filter((x) => b.has(x)).length;
  const uni = new Set([...a, ...b]).size;
  return uni ? inter / uni : 1;
};

// ---------- per-run context shape ----------
const keys = videos.flatMap((v) => GOALS.map((g) => ({ video: v.video, g, key: `${v.video}-${g}` })));
const perRun = keys.map(({ video, g, key }) => {
  const run = load(NEW, key);
  const ctx = run.blocks.map((b) => b.rollingContext ?? '');
  const lens = ctx.map((c) => c.length);
  const n = lens.length;
  const third = (k: number) => r2(mean(lens.slice(Math.floor((k * n) / 3), Math.floor(((k + 1) * n) / 3))));
  const consecutive = ctx.slice(1).map((c, i) => jaccard(words(ctx[i]!), words(c)));
  const form = ctx.filter((c) => /covered/i.test(c) && /relevant to goal/i.test(c) && /still open/i.test(c)).length;
  return {
    key,
    blocks: n,
    meanChars: r2(mean(lens)),
    maxChars: Math.max(...lens),
    charsByThird: [third(0), third(1), third(2)], // growth over the video
    atCap: lens.filter((l) => l >= MAX_CONTEXT_CHARS).length,
    empty: lens.filter((l) => l === 0).length,
    followsForm: form,
    consecutiveWordJaccard: r2(mean(consecutive)), // ~1 = notes barely change from block to block
    identicalToPrevious: consecutive.filter((j) => j === 1).length,
    contextInMatchesPrevious: run.blocks.slice(1).filter((b, i) => (b.contextIn ?? '') === (run.blocks[i]!.rollingContext ?? '')).length, // sanity: chronological hand-off
    judge: judge[video]!.map((s) => s[g]),
  };
});

// ---------- latency per block call ----------
const callStats = (dir: string) => {
  const durs: number[] = [];
  const totals: number[] = [];
  let retries = 0;
  let failed = 0;
  for (const { key } of keys) {
    const run = load(dir, key);
    for (const c of run.calls) if (c.type === 'block') durs.push(c.endMs - c.startMs);
    totals.push(run.totalMs);
    retries += run.blocks.reduce((a, b) => a + Math.max(0, b.calls - 1), 0);
    failed += run.blocks.filter((b) => b.relevance === null).length;
  }
  return {
    blockCalls: durs.length,
    callMeanS: r2(mean(durs) / 1000),
    callMedianS: r2(pctl(durs, 0.5) / 1000),
    callP90S: r2(pctl(durs, 0.9) / 1000),
    runTotalMeanS: r2(mean(totals) / 1000),
    runTotalsS: totals.map((t) => r2(t / 1000)),
    retries,
    failed,
  };
};
const latency = { base: callStats(BASE), neu: callStats(NEW) };

// Call time by position in the video (does a growing context slow later blocks?).
const durByThird = (dir: string) => {
  const out = [[], [], []] as number[][];
  for (const { key } of keys) {
    const bc = load(dir, key).calls.filter((c) => c.type === 'block');
    bc.forEach((c, i) => out[Math.min(2, Math.floor((3 * i) / bc.length))]!.push(c.endMs - c.startMs));
  }
  return out.map((d) => r2(mean(d) / 1000));
};
const callSByThird = { base: durByThird(BASE), neu: durByThird(NEW) };

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

const OLD_SYSTEM_PROMPT = (() => {
  const src = execSync('git show 1b69f3a:src/shared/goal-prompt.ts', { encoding: 'utf8' });
  return src.match(/BLOCK_SYSTEM_PROMPT = `([^`]*)`/)![1]!;
})();

const tokenTexts: { kind: string; text: string }[] = [
  { kind: 'system-base', text: OLD_SYSTEM_PROMPT },
  { kind: 'system-new', text: BLOCK_SYSTEM_PROMPT },
];
for (const { key } of keys) {
  const v = videos.find((x) => key.startsWith(x.video))!;
  const base = load(BASE, key);
  const neu = load(NEW, key);
  for (const b of base.blocks) {
    if (b.relevance === null) continue;
    tokenTexts.push({ kind: 'in-base', text: buildBlockPrompt(base.goal, b.text, v.title) }); // same format as 1.1 when there are no notes
    tokenTexts.push({ kind: 'out-base', text: JSON.stringify({ topic: b.topic, relevance: b.relevance, attention: b.attention, reason: b.reason }) });
  }
  for (const b of neu.blocks) {
    if (b.relevance === null) continue;
    tokenTexts.push({ kind: 'in-new', text: buildBlockPrompt(neu.goal, b.text, v.title, b.contextIn ?? undefined) });
    tokenTexts.push({ kind: 'out-new', text: JSON.stringify({ topic: b.topic, relevance: b.relevance, attention: b.attention, reason: b.reason, notes: b.rollingContext ?? '' }) });
    if (b.rollingContext) tokenTexts.push({ kind: 'notes', text: b.rollingContext });
  }
}

const counts = await measure(tokenTexts.map((t) => t.text));
const tokens = counts
  ? (() => {
      const by = (k: string) => counts.filter((_, i) => tokenTexts[i]!.kind === k).filter((x): x is number => x !== null);
      const s = (k: string) => ({ mean: r2(mean(by(k))), p90: pctl(by(k), 0.9), max: Math.max(...by(k)) });
      return { systemBase: by('system-base')[0], systemNew: by('system-new')[0], inBase: s('in-base'), inNew: s('in-new'), outBase: s('out-base'), outNew: s('out-new'), notes: s('notes') };
    })()
  : null;

// ---------- examples: every block's notes, for reading ----------
const examples = Object.fromEntries(
  keys.map(({ key }) => [
    key,
    load(NEW, key).blocks.map((b, i) => ({ i, rel: b.relevance, judge: perRun.find((r) => r.key === key)!.judge[i], topic: b.topic, notes: b.rollingContext })),
  ]),
);

const result = { perRun: perRun.map(({ judge: _j, ...r }) => r), latency, callSByThird, tokens, examples };
writeFileSync(`${NEW}/context.json`, JSON.stringify(result, null, 1));

const md: string[] = [`# POC 1.4 rolling context: shape and cost (generated by eval/goal-mode/context-metrics.ts)`, ''];
md.push('| Run | blocks | mean chars | max | chars by third of video | at cap | empty | follows form | consecutive word Jaccard | identical to previous | hand-off ok |');
md.push('|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of perRun)
  md.push(`| ${r.key} | ${r.blocks} | ${r.meanChars} | ${r.maxChars} | ${r.charsByThird.join(' / ')} | ${r.atCap} | ${r.empty} | ${r.followsForm} | ${r.consecutiveWordJaccard} | ${r.identicalToPrevious} | ${r.contextInMatchesPrevious}/${r.blocks - 1} |`);
md.push('', '| Cost | POC 1.1 | POC 1.4 |', '|---|---|---|');
for (const k of ['blockCalls', 'callMeanS', 'callMedianS', 'callP90S', 'runTotalMeanS', 'retries', 'failed'] as const) md.push(`| ${k} | ${latency.base[k]} | ${latency.neu[k]} |`);
md.push(`| call s by third of video | ${callSByThird.base.join(' / ')} | ${callSByThird.neu.join(' / ')} |`);
if (tokens) {
  md.push(`| system prompt tokens | ${tokens.systemBase} | ${tokens.systemNew} |`);
  md.push(`| input tokens/block mean (p90, max) | ${tokens.inBase.mean} (${tokens.inBase.p90}, ${tokens.inBase.max}) | ${tokens.inNew.mean} (${tokens.inNew.p90}, ${tokens.inNew.max}) |`);
  md.push(`| output tokens/block mean (p90, max) | ${tokens.outBase.mean} (${tokens.outBase.p90}, ${tokens.outBase.max}) | ${tokens.outNew.mean} (${tokens.outNew.p90}, ${tokens.outNew.max}) |`);
  md.push(`| notes tokens mean (p90, max) | – | ${tokens.notes.mean} (${tokens.notes.p90}, ${tokens.notes.max}) |`);
}
md.push('', `Run totals (s): POC 1.1 ${latency.base.runTotalsS.join(', ')}; POC 1.4 ${latency.neu.runTotalsS.join(', ')}`);
writeFileSync(`${NEW}/context.md`, md.join('\n') + '\n');
console.log(md.join('\n'));
