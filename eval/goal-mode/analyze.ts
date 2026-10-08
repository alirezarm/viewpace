/**
 * Evaluation-only: computes the Goal Mode POC 1.1 metrics from the raw runs and the blind judge.
 *
 *   npx esbuild eval/goal-mode/analyze.ts --bundle --platform=node --format=esm --outfile=/tmp/analyze.mjs && node /tmp/analyze.mjs
 *
 * Reads  $EVAL_RUNS/<video>-<A|B|C>.json (default eval-results/goal-mode-poc1/runs) and
 *        eval-results/goal-mode-poc1/judge/<video>.judge.json
 * Writes $EVAL_METRICS_OUT/metrics.json and metrics.md (default eval-results/goal-mode-poc1).
 *
 * Nothing here feeds back into Goal Mode; the production pacing table is imported only to label
 * judge scores with the same relevance categories.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { PROFILES } from '../../src/content/controller';
import { goalTarget } from '../../src/content/goal/goal-pacing';

const ROOT = 'eval-results/goal-mode-poc1';
/** Runs to analyse and where to write metrics (default: the POC 1.1 baseline). Judge scores always come from ROOT. */
const RUNS = process.env.EVAL_RUNS ?? `${ROOT}/runs`;
const OUT = process.env.EVAL_METRICS_OUT ?? ROOT;
const GOALS = ['A', 'B', 'C'] as const;
type G = (typeof GOALS)[number];

interface RunBlock {
  index: number;
  start: number;
  end: number;
  text: string;
  topic: string | null;
  relevance: number | null;
  attention: number | null;
  reason: string | null;
  category: string | null;
  targetRate: number | null;
  calls: number;
  ratedAtMs: number | null;
}
interface Call {
  type: 'block' | 'sections';
  startMs: number;
  endMs: number;
  ok: boolean;
  error?: string;
  sectionsValid?: boolean;
  blockChars?: number;
}
interface Run {
  goal: string;
  title: string;
  available: boolean;
  phase: string;
  totalMs: number;
  calls: Call[];
  blocks: RunBlock[];
  sections: { start: number; end: number; topic: string; firstBlock: number; lastBlock: number }[];
  transcript: { kind: string; timing: string; words: number; endSec: number };
}
interface Judge {
  scores: { index: number; A: number; B: number; C: number }[];
}

const videos: { video: string; title: string; goals: Record<G, string> }[] = JSON.parse(readFileSync('eval/goal-mode/goals.json', 'utf8'));

/** The CLI may save evaluate_script output wrapped in prose / a ```json fence; take the JSON object. */
function loadRun(path: string): Run | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8');
  const s = raw.indexOf('{');
  const e = raw.lastIndexOf('}');
  const state = JSON.parse(raw.slice(s, e + 1));
  return (state.result ?? state) as Run;
}

// ---------- stats helpers ----------
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const sd = (a: number[]) => {
  const m = mean(a);
  return Math.sqrt(mean(a.map((x) => (x - m) ** 2)));
};
const pct = (n: number, d: number) => (d ? (100 * n) / d : NaN);
function pearson(x: number[], y: number[]): number {
  const mx = mean(x);
  const my = mean(y);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < x.length; i++) {
    num += (x[i]! - mx) * (y[i]! - my);
    dx += (x[i]! - mx) ** 2;
    dy += (y[i]! - my) ** 2;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : NaN;
}
function ranks(a: number[]): number[] {
  const idx = a.map((v, i) => [v, i] as const).sort((p, q) => p[0] - q[0]);
  const r = new Array<number>(a.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j++;
    for (let k = i; k <= j; k++) r[idx[k]![1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return r;
}
const spearman = (x: number[], y: number[]) => pearson(ranks(x), ranks(y));
const r2 = (x: number) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);

function distribution(a: number[]) {
  const hist = Array.from({ length: 11 }, (_, v) => a.filter((x) => x === v).length);
  return {
    n: a.length,
    mean: r2(mean(a)),
    median: median(a),
    sd: r2(sd(a)),
    min: Math.min(...a),
    max: Math.max(...a),
    hist,
    pctGe7: r2(pct(a.filter((x) => x >= 7).length, a.length)),
    pctGe8: r2(pct(a.filter((x) => x >= 8).length, a.length)),
  };
}

/** Top ceil(20%) blocks by relevance; ties broken by attention, then earlier block (deterministic). */
function top20(blocks: RunBlock[]): Set<number> {
  const k = Math.ceil(blocks.length * 0.2);
  const s = [...blocks].filter((b) => b.relevance !== null).sort((p, q) => q.relevance! - p.relevance! || q.attention! - p.attention! || p.index - q.index);
  return new Set(s.slice(0, k).map((b) => b.index));
}
/** Same, over the set of all blocks whose relevance is >= the k-th highest value (tie-inclusive). */
function top20Inclusive(rel: number[]): Set<number> {
  const k = Math.ceil(rel.length * 0.2);
  const cut = [...rel].sort((a, b) => b - a)[k - 1]!;
  return new Set(rel.flatMap((v, i) => (v >= cut ? [i] : [])));
}
const jaccard = (a: Set<number>, b: Set<number>) => {
  const inter = [...a].filter((x) => b.has(x)).length;
  const uni = new Set([...a, ...b]).size;
  return uni ? inter / uni : NaN;
};

const normal = PROFILES.normal;
const bucket = (rel: number) => goalTarget({ relevance: rel, attention: 0 }, normal).label.replace('Important for your goal', 'High (≥7)');

// ---------- latency ----------
/** Simulate playback from 0:00 at a constant rate: seconds of content played while its block was not yet rated. */
function unmappedPlayback(run: Run, rate: number): number {
  let lost = 0;
  for (const b of run.blocks) {
    const reachMs = (b.start / rate) * 1000;
    const leaveMs = (b.end / rate) * 1000;
    const ready = b.ratedAtMs ?? Infinity;
    if (ready > reachMs) lost += (Math.min(ready, leaveMs) - reachMs) / 1000 * rate;
  }
  return lost;
}
function latency(run: Run) {
  const rated = run.blocks.filter((b) => b.ratedAtMs !== null);
  const blockCalls = run.calls.filter((c) => c.type === 'block');
  const sectionCalls = run.calls.filter((c) => c.type === 'sections');
  const durations = blockCalls.filter((c) => c.ok).map((c) => c.endMs - c.startMs);
  const first5min = run.blocks.filter((b) => b.start < 300);
  const contentSec = run.transcript.endSec;
  const lastRated = Math.max(...rated.map((b) => b.ratedAtMs!));
  return {
    blocks: run.blocks.length,
    contentMin: r2(contentSec / 60),
    firstCompletedBlockS: r2(Math.min(...rated.map((b) => b.ratedAtMs!)) / 1000),
    // Start is at 0:00, so the first decision needs the block containing t=0.
    firstUsefulDecisionS: r2((run.blocks[0]!.ratedAtMs ?? NaN) / 1000),
    first5MinMappedS: first5min.every((b) => b.ratedAtMs !== null) ? r2(Math.max(...first5min.map((b) => b.ratedAtMs!)) / 1000) : null,
    allBlocksRatedS: r2(lastRated / 1000),
    completeMapS: r2(run.totalMs / 1000),
    mappingSpeedX: r2(contentSec / (lastRated / 1000)), // content seconds mapped per wall second
    unmappedSecAt1x: r2(unmappedPlayback(run, 1)),
    unmappedSecAt2x: r2(unmappedPlayback(run, 2)),
    blockCalls: blockCalls.length,
    retries: run.blocks.filter((b) => b.calls > 1).length,
    failedCalls: blockCalls.filter((c) => !c.ok).length,
    failedBlocks: run.blocks.filter((b) => b.relevance === null).length,
    blockCallMedianS: r2(median(durations) / 1000),
    blockCallP90S: r2([...durations].sort((a, b) => a - b)[Math.floor(durations.length * 0.9)]! / 1000),
    sectionCalls: sectionCalls.length,
    sectionCallsValid: sectionCalls.filter((c) => c.sectionsValid).length,
    sectionsShown: run.sections.length,
    errors: [...new Set(run.calls.filter((c) => !c.ok).map((c) => c.error))],
  };
}

// ---------- main ----------
const out: Record<string, unknown> = {};
const md: string[] = [];
const excerpt = (t: string, n = 220) => (t.length > n ? t.slice(0, n) + '…' : t);
const ts = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const pooled = { gm: [] as number[], j: [] as number[] };
const pooledSens = { gm: [] as number[], j: [] as number[] };

for (const v of videos) {
  const runs = Object.fromEntries(GOALS.map((g) => [g, loadRun(`${RUNS}/${v.video}-${g}.json`)])) as Record<G, Run | null>;
  const judgePath = `${ROOT}/judge/${v.video}.judge.json`;
  const judge: Judge | null = existsSync(judgePath) ? JSON.parse(readFileSync(judgePath, 'utf8')) : null;
  const vo: Record<string, unknown> = { title: v.title };
  md.push(`\n## ${v.title} (${v.video})\n`);

  // Distributions
  const dist: Record<string, unknown> = {};
  md.push('| Goal | rel mean | rel median | rel sd | rel min–max | rel ≥7 % | rel ≥8 % | att mean | att median | att sd | att ≥7 % | high-bunched? |', '|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const g of GOALS) {
    const r = runs[g];
    if (!r) continue;
    const rel = r.blocks.flatMap((b) => (b.relevance === null ? [] : [b.relevance]));
    const att = r.blocks.flatMap((b) => (b.attention === null ? [] : [b.attention]));
    const dr = distribution(rel);
    const da = distribution(att);
    // Flag: most of the video scored as relevant for a goal that targets one part of it.
    const bunched = dr.median >= 7 || (dr.pctGe7 ?? 0) >= 50;
    dist[g] = { relevance: dr, attention: da, highBunched: bunched };
    md.push(`| ${g} | ${dr.mean} | ${dr.median} | ${dr.sd} | ${dr.min}–${dr.max} | ${dr.pctGe7} | ${dr.pctGe8} | ${da.mean} | ${da.median} | ${da.sd} | ${da.pctGe7} | ${bunched ? '**yes**' : 'no'} |`);
  }
  md.push('', 'Relevance histograms (count of blocks scoring 0…10):', '');
  for (const g of GOALS) if (dist[g]) md.push(`- ${g}: \`${(dist[g] as any).relevance.hist.join(' ')}\``);
  md.push('', 'Attention histograms (0…10):', '');
  for (const g of GOALS) if (dist[g]) md.push(`- ${g}: \`${(dist[g] as any).attention.hist.join(' ')}\``);
  if (judge) {
    md.push('', 'Judge relevance histograms (0…10), for comparison:', '');
    for (const g of GOALS) md.push(`- ${g}: \`${distribution(judge.scores.map((s) => s[g])).hist.join(' ')}\``);
  }
  vo.distributions = dist;

  // Goal sensitivity
  const sens: Record<string, unknown> = {};
  md.push('', '| Pair | mean abs Δrel | Δrel ≥2 % | Δrel ≥3 % | top-20% Jaccard | top-20% Jaccard (ties incl.) | speed differs % | mean abs Δspeed | time-weighted abs Δspeed | judge mean abs Δrel | judge top-20% Jaccard |', '|---|---|---|---|---|---|---|---|---|---|---|');
  for (const [a, b] of [['A', 'B'], ['A', 'C'], ['B', 'C']] as [G, G][]) {
    const ra = runs[a];
    const rb = runs[b];
    if (!ra || !rb) continue;
    const both = ra.blocks.filter((x, i) => x.relevance !== null && rb.blocks[i]!.relevance !== null).map((x) => [x, rb.blocks[x.index]!] as const);
    const d = both.map(([x, y]) => Math.abs(x.relevance! - y.relevance!));
    const ds = both.map(([x, y]) => Math.abs(x.targetRate! - y.targetRate!));
    const w = both.map(([x]) => x.end - x.start);
    const tw = ds.reduce((s, x, i) => s + x * w[i]!, 0) / w.reduce((s, x) => s + x, 0);
    const relA = both.map(([x]) => x.relevance!);
    const relB = both.map(([, y]) => y.relevance!);
    let judgeD: number | null = null;
    let judgeJ: number | null = null;
    if (judge) {
      const ja = judge.scores.map((s) => s[a]);
      const jb = judge.scores.map((s) => s[b]);
      judgeD = r2(mean(ja.map((x, i) => Math.abs(x - jb[i]!))));
      judgeJ = r2(jaccard(top20Inclusive(ja), top20Inclusive(jb)));
      pooledSens.j.push(...ja.map((x, i) => Math.abs(x - jb[i]!)));
    }
    pooledSens.gm.push(...d);
    const row = {
      n: both.length,
      meanAbsRelDiff: r2(mean(d)),
      pctRelDiffGe2: r2(pct(d.filter((x) => x >= 2).length, d.length)),
      pctRelDiffGe3: r2(pct(d.filter((x) => x >= 3).length, d.length)),
      top20Jaccard: r2(jaccard(top20(ra.blocks), top20(rb.blocks))),
      top20JaccardTiesIncl: r2(jaccard(top20Inclusive(relA), top20Inclusive(relB))),
      pctSpeedDiffers: r2(pct(ds.filter((x) => x > 1e-9).length, ds.length)),
      meanAbsSpeedDiff: r2(mean(ds)),
      timeWeightedAbsSpeedDiff: r2(tw),
      judgeMeanAbsRelDiff: judgeD,
      judgeTop20Jaccard: judgeJ,
    };
    sens[`${a}-${b}`] = row;
    md.push(`| ${a}–${b} | ${row.meanAbsRelDiff} | ${row.pctRelDiffGe2} | ${row.pctRelDiffGe3} | ${row.top20Jaccard} | ${row.top20JaccardTiesIncl} | ${row.pctSpeedDiffers} | ${row.meanAbsSpeedDiff} | ${row.timeWeightedAbsSpeedDiff} | ${judgeD ?? '–'} | ${judgeJ ?? '–'} |`);
  }
  vo.sensitivity = sens;

  // Judge agreement
  if (judge) {
    const agree: Record<string, unknown> = {};
    md.push('', '| Goal | Pearson | Spearman | MAE | GM ≥7 | judge ≥7 | both ≥7 | precision of GM ≥7 | recall of judge ≥7 | false-high (GM≥7, J≤3) | false-low (GM≤3, J≥7) | same category % |', '|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const g of GOALS) {
      const r = runs[g];
      if (!r) continue;
      const pairs = r.blocks.filter((b) => b.relevance !== null).map((b) => ({ b, j: judge.scores[b.index]![g] }));
      const gm = pairs.map((p) => p.b.relevance!);
      const j = pairs.map((p) => p.j);
      pooled.gm.push(...gm);
      pooled.j.push(...j);
      const gmHigh = pairs.filter((p) => p.b.relevance! >= 7);
      const jHigh = pairs.filter((p) => p.j >= 7);
      const bothHigh = pairs.filter((p) => p.b.relevance! >= 7 && p.j >= 7);
      const falseHigh = pairs.filter((p) => p.b.relevance! >= 7 && p.j <= 3);
      const falseLow = pairs.filter((p) => p.b.relevance! <= 3 && p.j >= 7);
      const sameCat = pairs.filter((p) => bucket(p.b.relevance!) === bucket(p.j));
      const largest = [...pairs].sort((p, q) => Math.abs(q.b.relevance! - q.j) - Math.abs(p.b.relevance! - p.j) || p.b.index - q.b.index).slice(0, 4);
      const row = {
        pearson: r2(pearson(gm, j)),
        spearman: r2(spearman(gm, j)),
        mae: r2(mean(gm.map((x, i) => Math.abs(x - j[i]!)))),
        gmHigh: gmHigh.length,
        judgeHigh: jHigh.length,
        bothHigh: bothHigh.length,
        precisionHigh: r2(gmHigh.length ? bothHigh.length / gmHigh.length : NaN),
        recallHigh: r2(jHigh.length ? bothHigh.length / jHigh.length : NaN),
        falseHigh: falseHigh.map((p) => p.b.index),
        falseLow: falseLow.map((p) => p.b.index),
        pctSameCategory: r2(pct(sameCat.length, pairs.length)),
        largestDisagreements: largest.map((p) => ({
          index: p.b.index,
          time: `${ts(p.b.start)}–${ts(p.b.end)}`,
          goalMode: { relevance: p.b.relevance, attention: p.b.attention, topic: p.b.topic, reason: p.b.reason, speed: p.b.targetRate },
          judge: p.j,
          text: excerpt(p.b.text),
        })),
      };
      agree[g] = row;
      md.push(`| ${g} | ${row.pearson} | ${row.spearman} | ${row.mae} | ${row.gmHigh} | ${row.judgeHigh} | ${row.bothHigh} | ${row.precisionHigh ?? '–'} | ${row.recallHigh ?? '–'} | ${falseHigh.length} | ${falseLow.length} | ${row.pctSameCategory} |`);
    }
    // Practical impact on playback (Normal pace): where the slow time goes, and what judge-based pacing would give.
    const impact: Record<string, unknown> = {};
    md.push('', '| Goal | watch time at 1× min | watch time with Goal Mode min | with judge scores min | slow time (≤1.15×) min | …of which judge ≤3 % | judge ≥7 content played ≥1.75× min |', '|---|---|---|---|---|---|---|');
    for (const g of GOALS) {
      const r = runs[g];
      if (!r) continue;
      let gmT = 0;
      let jT = 0;
      let slow = 0;
      let slowIrrelevant = 0;
      let fastRelevant = 0;
      let raw = 0;
      for (const b of r.blocks) {
        const dur = b.end - b.start;
        raw += dur;
        const j = judge.scores[b.index]![g];
        const jRate = goalTarget({ relevance: j, attention: b.attention ?? 0 }, normal).rate;
        const rate = b.targetRate ?? 1;
        gmT += dur / rate;
        jT += dur / jRate;
        if (rate <= 1.15 + 1e-9) {
          slow += dur / rate;
          if (j <= 3) slowIrrelevant += dur / rate;
        }
        if (j >= 7 && rate >= 1.75 - 1e-9) fastRelevant += dur / rate;
      }
      const row = { rawMin: r2(raw / 60), goalModeMin: r2(gmT / 60), judgePacedMin: r2(jT / 60), slowMin: r2(slow / 60), slowOnJudgeIrrelevantPct: r2(pct(slowIrrelevant, slow)), judgeRelevantFastMin: r2(fastRelevant / 60) };
      impact[g] = row;
      md.push(`| ${g} | ${row.rawMin} | ${row.goalModeMin} | ${row.judgePacedMin} | ${row.slowMin} | ${row.slowOnJudgeIrrelevantPct} | ${row.judgeRelevantFastMin} |`);
    }
    vo.playbackImpact = impact;
    md.push('', 'Largest disagreements:', '');
    for (const g of GOALS) {
      const a = agree[g] as any;
      if (!a) continue;
      for (const x of a.largestDisagreements.slice(0, 2)) {
        md.push(`- **${g}, block ${x.index} (${x.time})**: Goal Mode R${x.goalMode.relevance}/A${x.goalMode.attention} → ${x.goalMode.speed}× ("${x.goalMode.topic}"; reason: "${x.goalMode.reason}"), judge ${x.judge}. Text: "${x.text}"`);
      }
    }
    vo.judgeAgreement = agree;
  }

  // Latency
  const lat: Record<string, unknown> = {};
  md.push('', '| Goal | blocks | first block s | first decision s | first 5 min mapped s | all rated s | complete map s | mapping speed × | unmapped s @1× | unmapped s @2× | block calls | retries | failed blocks | call median s | call p90 s | section calls (valid) |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const g of GOALS) {
    const r = runs[g];
    if (!r) continue;
    const l = latency(r);
    lat[g] = l;
    md.push(`| ${g} | ${l.blocks} | ${l.firstCompletedBlockS} | ${l.firstUsefulDecisionS} | ${l.first5MinMappedS ?? '–'} | ${l.allBlocksRatedS} | ${l.completeMapS} | ${l.mappingSpeedX} | ${l.unmappedSecAt1x} | ${l.unmappedSecAt2x} | ${l.blockCalls} | ${l.retries} | ${l.failedBlocks} | ${l.blockCallMedianS} | ${l.blockCallP90S} | ${l.sectionCalls} (${l.sectionCallsValid}) |`);
  }
  vo.latency = lat;
  out[v.video] = vo;
}

const cross = {
  pooledPearson: r2(pearson(pooled.gm, pooled.j)),
  pooledSpearman: r2(spearman(pooled.gm, pooled.j)),
  pooledMae: r2(mean(pooled.gm.map((x, i) => Math.abs(x - pooled.j[i]!)))),
  gmMeanAbsGoalDiff: r2(mean(pooledSens.gm)),
  judgeMeanAbsGoalDiff: r2(mean(pooledSens.j)),
  gmRelevance: distribution(pooled.gm),
  judgeRelevance: distribution(pooled.j),
};
out.crossVideo = cross;
md.unshift('# Goal Mode POC 1.1 metrics (generated by eval/goal-mode/analyze.ts)', '', '```json', JSON.stringify(cross, null, 1), '```');
writeFileSync(`${OUT}/metrics.json`, JSON.stringify(out, null, 2));
writeFileSync(`${OUT}/metrics.md`, md.join('\n') + '\n');
console.log(md.join('\n'));
