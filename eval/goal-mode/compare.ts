/**
 * Evaluation-only: the POC 1.1 baseline vs a later variant ($EVAL_NEW, default POC 1.2) on the same
 * transcripts, blocks, goals and saved judge scores.
 *
 *   EVAL_NEW=eval-results/goal-mode-poc1.3a npx esbuild eval/goal-mode/compare.ts --bundle --platform=node --format=esm --outfile=/tmp/compare.mjs && node /tmp/compare.mjs
 *
 * Needs metrics.json in both result folders (run analyze.ts with EVAL_RUNS/EVAL_METRICS_OUT first).
 * Writes $EVAL_NEW/compare.json and compare.md. For a categorical scorer it also reports what
 * category Nano chose (relevanceCategory in the raw runs).
 */
import { readFileSync, writeFileSync } from 'node:fs';

const OLD = 'eval-results/goal-mode-poc1';
const NEW = process.env.EVAL_NEW ?? 'eval-results/goal-mode-poc1.2';
const GOALS = ['A', 'B', 'C'] as const;
type G = (typeof GOALS)[number];

interface Block {
  index: number;
  start: number;
  end: number;
  text: string;
  topic: string;
  relevance: number | null;
  attention: number | null;
  reason: string;
  targetRate: number | null;
  calls: number;
  relevanceCategory?: string | null;
}
interface Run {
  blocks: Block[];
  calls: { type: string; ok: boolean; startMs: number; endMs: number; sectionsValid?: boolean }[];
  totalMs: number;
}

const videos: { video: string; title: string }[] = JSON.parse(readFileSync('eval/goal-mode/goals.json', 'utf8'));
const loadRun = (root: string, v: string, g: G): Run => {
  const raw = readFileSync(`${root}/runs/${v}-${g}.json`, 'utf8');
  const s = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  return (s.result ?? s) as Run;
};
const judge = (v: string): Record<G, number>[] => JSON.parse(readFileSync(`${OLD}/judge/${v}.judge.json`, 'utf8')).scores;
const metrics = (root: string) => JSON.parse(readFileSync(`${root}/metrics.json`, 'utf8'));

const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const sd = (a: number[]) => Math.sqrt(mean(a.map((x) => (x - mean(a)) ** 2)));
function pearson(x: number[], y: number[]) {
  const mx = mean(x);
  const my = mean(y);
  let n = 0;
  let a = 0;
  let b = 0;
  for (let i = 0; i < x.length; i++) {
    n += (x[i]! - mx) * (y[i]! - my);
    a += (x[i]! - mx) ** 2;
    b += (y[i]! - my) ** 2;
  }
  return n / Math.sqrt(a * b);
}
function ranks(a: number[]) {
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
const r2 = (x: number) => Math.round(x * 100) / 100;
const pct = (n: number, d: number) => r2((100 * n) / d);
const ts = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const excerpt = (t: string, n = 200) => (t.length > n ? t.slice(0, n) + '…' : t);

interface Row {
  video: string;
  goal: G;
  index: number;
  time: string;
  j: number;
  old: Block;
  neu: Block;
}
const rows: Row[] = [];
for (const v of videos) {
  const J = judge(v.video);
  for (const g of GOALS) {
    const o = loadRun(OLD, v.video, g);
    const n = loadRun(NEW, v.video, g);
    o.blocks.forEach((b, i) => rows.push({ video: v.video, goal: g, index: i, time: `${ts(b.start)}–${ts(b.end)}`, j: J[i]![g], old: b, neu: n.blocks[i]! }));
  }
}

function summary(pick: (r: Row) => Block, root: string) {
  const rated = rows.filter((r) => pick(r).relevance !== null);
  const gm = rated.map((r) => pick(r).relevance!);
  const j = rated.map((r) => r.j);
  const gmHigh = rated.filter((r) => pick(r).relevance! >= 7);
  const jHigh = rated.filter((r) => r.j >= 7);
  const both = gmHigh.filter((r) => r.j >= 7);
  const falseHigh = gmHigh.filter((r) => r.j <= 3);
  const falseLow = rated.filter((r) => pick(r).relevance! <= 3 && r.j >= 7);
  const hist = Array.from({ length: 11 }, (_, v) => gm.filter((x) => x === v).length);
  // Blocks rated >=7 for two or more goals of the same video.
  let multi = 0;
  for (const v of videos) {
    const count = rows.filter((r) => r.video === v.video && r.goal === 'A').length;
    for (let i = 0; i < count; i++) {
      const highs = rows.filter((r) => r.video === v.video && r.index === i && (pick(r).relevance ?? 0) >= 7).length;
      if (highs >= 2) multi++;
    }
  }
  const m = metrics(root);
  const pairs: any[] = [];
  const impacts: any[] = [];
  const lat: any[] = [];
  for (const v of videos) {
    pairs.push(...Object.values(m[v.video].sensitivity));
    impacts.push(...Object.values(m[v.video].playbackImpact));
    lat.push(...Object.values(m[v.video].latency));
  }
  const avg = (a: any[], k: string) => r2(mean(a.map((x) => x[k])));
  const raw = impacts.reduce((s, x) => s + x.rawMin, 0);
  const watch = impacts.reduce((s, x) => s + x.goalModeMin, 0);
  const slow = impacts.reduce((s, x) => s + x.slowMin, 0);
  const slowLow = impacts.reduce((s, x) => s + (x.slowMin * x.slowOnJudgeIrrelevantPct) / 100, 0);
  const judgeHighFast = impacts.reduce((s, x) => s + x.judgeRelevantFastMin, 0);
  return {
    ratings: rated.length,
    unrated: rows.length - rated.length,
    precisionHigh: r2(both.length / gmHigh.length),
    recallHigh: r2(both.length / jHigh.length),
    gmHigh: gmHigh.length,
    judgeHigh: jHigh.length,
    bothHigh: both.length,
    falseHigh: falseHigh.length,
    falseHighPctOfGmHigh: pct(falseHigh.length, gmHigh.length),
    falseHighPctOfAll: pct(falseHigh.length, rated.length),
    falseLow: falseLow.length,
    pearson: r2(pearson(gm, j)),
    spearman: r2(pearson(ranks(gm), ranks(j))),
    mae: r2(mean(gm.map((x, i) => Math.abs(x - j[i]!)))),
    meanSigned: r2(mean(gm.map((x, i) => x - j[i]!))),
    relMean: r2(mean(gm)),
    relMedian: median(gm),
    relSd: r2(sd(gm)),
    pctGe7: pct(gm.filter((x) => x >= 7).length, gm.length),
    pctGe8: pct(gm.filter((x) => x >= 8).length, gm.length),
    hist,
    attMean: r2(mean(rated.map((r) => pick(r).attention!))),
    multiGoalHigh: multi,
    sensitivity: {
      meanAbsRelDiff: avg(pairs, 'meanAbsRelDiff'),
      pctRelDiffGe2: avg(pairs, 'pctRelDiffGe2'),
      pctRelDiffGe3: avg(pairs, 'pctRelDiffGe3'),
      top20Jaccard: avg(pairs, 'top20Jaccard'),
      top20JaccardTiesIncl: avg(pairs, 'top20JaccardTiesIncl'),
      maxTop20JaccardTiesIncl: Math.max(...pairs.map((p) => p.top20JaccardTiesIncl)),
      pctSpeedDiffers: avg(pairs, 'pctSpeedDiffers'),
      meanAbsSpeedDiff: avg(pairs, 'meanAbsSpeedDiff'),
    },
    playback: {
      rawMin: r2(raw),
      goalModeMin: r2(watch),
      reductionPct: pct(raw - watch, raw),
      judgePacedMin: r2(impacts.reduce((s, x) => s + x.judgePacedMin, 0)),
      slowMin: r2(slow),
      slowOnJudgeLowPct: pct(slowLow, slow),
      judgeHighPlayedFastMin: r2(judgeHighFast),
    },
    latency: {
      firstDecisionS: avg(lat, 'firstUsefulDecisionS'),
      maxFirstDecisionS: Math.max(...lat.map((l) => l.firstUsefulDecisionS)),
      first5MinS: avg(lat, 'first5MinMappedS'),
      callMedianS: avg(lat, 'blockCallMedianS'),
      mappingSpeedX: avg(lat, 'mappingSpeedX'),
      retries: lat.reduce((s, l) => s + l.retries, 0),
      failedBlocks: lat.reduce((s, l) => s + l.failedBlocks, 0),
      sectionCalls: lat.reduce((s, l) => s + l.sectionCalls, 0),
      sectionCallsValid: lat.reduce((s, l) => s + l.sectionCallsValid, 0),
    },
  };
}

const old = summary((r) => r.old, OLD);
const neu = summary((r) => r.neu, NEW);

// Per-run precision/recall/false-high.
const perRun = videos.flatMap((v) =>
  GOALS.map((g) => {
    const rs = rows.filter((r) => r.video === v.video && r.goal === g);
    const f = (pick: (r: Row) => Block) => {
      const h = rs.filter((r) => (pick(r).relevance ?? -1) >= 7);
      const jh = rs.filter((r) => r.j >= 7);
      const b = h.filter((r) => r.j >= 7);
      return { gmHigh: h.length, prec: h.length ? r2(b.length / h.length) : null, rec: jh.length ? r2(b.length / jh.length) : null, fh: h.filter((r) => r.j <= 3).length };
    };
    return { video: v.video, goal: g, judgeHigh: rs.filter((r) => r.j >= 7).length, old: f((r) => r.old), neu: f((r) => r.neu) };
  }),
);

// Regression categories.
const nr = (r: Row) => r.neu.relevance ?? -1;
const or = (r: Row) => r.old.relevance ?? -1;
const fixedFalseHigh = rows.filter((r) => or(r) >= 7 && r.j <= 3 && nr(r) < 7);
const remainingFalseHigh = rows.filter((r) => nr(r) >= 7 && r.j <= 3);
const newFalseHigh = remainingFalseHigh.filter((r) => or(r) < 7);
const correctHighLost = rows.filter((r) => or(r) >= 7 && r.j >= 7 && nr(r) < 7);
const judgeHighMissed = rows.filter((r) => r.j >= 7 && nr(r) < 7);
const judgeHighFalseLow = rows.filter((r) => r.j >= 7 && nr(r) <= 3 && nr(r) >= 0);
const judgeMidDrop = rows.filter((r) => r.j >= 5 && r.j <= 6 && nr(r) <= 3 && or(r) >= 5);
const transitions = {
  oldHighToNewLow: rows.filter((r) => or(r) >= 7 && nr(r) <= 4).length,
  oldHighToNewMid: rows.filter((r) => or(r) >= 7 && nr(r) >= 5 && nr(r) <= 6).length,
  oldHighStayHigh: rows.filter((r) => or(r) >= 7 && nr(r) >= 7).length,
  oldLowToNewHigh: rows.filter((r) => or(r) < 7 && nr(r) >= 7).length,
  meanChange: r2(mean(rows.filter((r) => nr(r) >= 0 && or(r) >= 0).map((r) => nr(r) - or(r)))),
};

const ex = (r: Row) => ({
  video: r.video,
  goal: r.goal,
  index: r.index,
  time: r.time,
  judge: r.j,
  old: { relevance: r.old.relevance, attention: r.old.attention, speed: r.old.targetRate, reason: r.old.reason },
  new: { relevance: r.neu.relevance, attention: r.neu.attention, speed: r.neu.targetRate, topic: r.neu.topic, reason: r.neu.reason },
  text: excerpt(r.old.text),
});
const examples = {
  fixedFalseHigh: fixedFalseHigh.map(ex),
  remainingFalseHigh: remainingFalseHigh.map(ex),
  newFalseHigh: newFalseHigh.map(ex),
  correctHighLost: correctHighLost.map(ex),
  judgeHighMissed: judgeHighMissed.map(ex),
  judgeHighFalseLow: judgeHighFalseLow.map(ex),
  judgeMidDroppedToLow: judgeMidDrop.map(ex),
};

// Categorical scorer: what Nano chose, overall and per run, and how categories change with the goal.
const CATS = ['irrelevant', 'background', 'useful', 'important', 'essential'];
const catRows = rows.filter((r) => r.neu.relevanceCategory);
const catCount = (rs: Row[]) => Object.fromEntries(CATS.map((c) => [c, rs.filter((r) => r.neu.relevanceCategory === c).length]));
const categories = catRows.length
  ? {
      rated: catRows.length,
      overall: catCount(catRows),
      overallPct: Object.fromEntries(CATS.map((c) => [c, pct(catRows.filter((r) => r.neu.relevanceCategory === c).length, catRows.length)])),
      perRun: Object.fromEntries(videos.flatMap((v) => GOALS.map((g) => [`${v.video}-${g}`, catCount(catRows.filter((r) => r.video === v.video && r.goal === g))]))),
      // Judge score distribution within each chosen category.
      judgeByCategory: Object.fromEntries(
        CATS.map((c) => {
          const js = catRows.filter((r) => r.neu.relevanceCategory === c).map((r) => r.j);
          return [c, { n: js.length, judgeMean: js.length ? r2(mean(js)) : null, judgeLe3: js.filter((x) => x <= 3).length, judgeGe7: js.filter((x) => x >= 7).length }];
        }),
      ),
      // Same block, different goals: does the chosen category change?
      blocksChangingCategoryPct: (() => {
        let changed = 0;
        let pairs = 0;
        for (const v of videos) {
          const n = rows.filter((r) => r.video === v.video && r.goal === 'A').length;
          for (let i = 0; i < n; i++) {
            const cs = GOALS.map((g) => rows.find((r) => r.video === v.video && r.goal === g && r.index === i)!.neu.relevanceCategory);
            for (const [a, b] of [[0, 1], [0, 2], [1, 2]] as const) {
              if (!cs[a] || !cs[b]) continue;
              pairs++;
              if (cs[a] !== cs[b]) changed++;
            }
          }
        }
        return pct(changed, pairs);
      })(),
      // Jaccard of the important|essential block sets between goals of the same video.
      highSetJaccard: (() => {
        const out: number[] = [];
        for (const v of videos) {
          const set = (g: G) => new Set(rows.filter((r) => r.video === v.video && r.goal === g && (r.neu.relevance ?? 0) >= 7).map((r) => r.index));
          for (const [a, b] of [['A', 'B'], ['A', 'C'], ['B', 'C']] as [G, G][]) {
            const x = set(a);
            const y = set(b);
            const inter = [...x].filter((i) => y.has(i)).length;
            const uni = new Set([...x, ...y]).size;
            out.push(uni ? inter / uni : 0);
          }
        }
        return { mean: r2(mean(out)), max: r2(Math.max(...out)), perPair: out.map(r2) };
      })(),
    }
  : null;
// Same high-set Jaccard for the baseline (numeric >= 7), for comparison.
const oldHighSetJaccard = (() => {
  const out: number[] = [];
  for (const v of videos) {
    const set = (g: G) => new Set(rows.filter((r) => r.video === v.video && r.goal === g && (r.old.relevance ?? 0) >= 7).map((r) => r.index));
    for (const [a, b] of [['A', 'B'], ['A', 'C'], ['B', 'C']] as [G, G][]) {
      const x = set(a);
      const y = set(b);
      const inter = [...x].filter((i) => y.has(i)).length;
      const uni = new Set([...x, ...y]).size;
      out.push(uni ? inter / uni : 0);
    }
  }
  return { mean: r2(mean(out)), max: r2(Math.max(...out)) };
})();
// Blocks whose category spans >= 3 levels across the three goals (e.g. irrelevant for one goal, important for another).
const goalSwings = catRows.length
  ? videos.flatMap((v) => {
      const n = rows.filter((r) => r.video === v.video && r.goal === 'A').length;
      return Array.from({ length: n }, (_, i) => GOALS.map((g) => rows.find((r) => r.video === v.video && r.goal === g && r.index === i)!)).filter((rs) => {
        const lv = rs.map((r) => CATS.indexOf(r.neu.relevanceCategory ?? ''));
        return Math.max(...lv) - Math.min(...lv) >= 3 && lv.every((x) => x >= 0);
      });
    })
  : [];

writeFileSync(`${NEW}/compare.json`, JSON.stringify({ old, new: neu, categories, oldHighSetJaccard, perRun, transitions, counts: Object.fromEntries(Object.entries(examples).map(([k, v]) => [k, v.length])), examples }, null, 2));

const label = NEW.split('/').pop()!.replace('goal-mode-poc', 'POC ');
const md: string[] = [`# POC 1.1 vs ${label} (generated by eval/goal-mode/compare.ts)`, ''];
const line = (label: string, a: unknown, b: unknown) => md.push(`| ${label} | ${a} | ${b} |`);
md.push(`| Metric | POC 1.1 | ${label} |`, '|---|---|---|');
line('Precision (GM ≥7 that judge ≥7)', `${old.precisionHigh} (${old.bothHigh}/${old.gmHigh})`, `${neu.precisionHigh} (${neu.bothHigh}/${neu.gmHigh})`);
line('Recall (judge ≥7 that GM ≥7)', `${old.recallHigh} (${old.bothHigh}/${old.judgeHigh})`, `${neu.recallHigh} (${neu.bothHigh}/${neu.judgeHigh})`);
line('False-high (GM ≥7, J ≤3)', `${old.falseHigh} (${old.falseHighPctOfGmHigh}% of GM-high, ${old.falseHighPctOfAll}% of all)`, `${neu.falseHigh} (${neu.falseHighPctOfGmHigh}% of GM-high, ${neu.falseHighPctOfAll}% of all)`);
line('False-low (GM ≤3, J ≥7)', old.falseLow, neu.falseLow);
line('Pearson / Spearman / MAE / mean signed error', `${old.pearson} / ${old.spearman} / ${old.mae} / ${old.meanSigned}`, `${neu.pearson} / ${neu.spearman} / ${neu.mae} / ${neu.meanSigned}`);
line('Relevance mean / median / sd', `${old.relMean} / ${old.relMedian} / ${old.relSd}`, `${neu.relMean} / ${neu.relMedian} / ${neu.relSd}`);
line('% ≥7 / % ≥8', `${old.pctGe7} / ${old.pctGe8}`, `${neu.pctGe7} / ${neu.pctGe8}`);
line('Histogram 0…10', `\`${old.hist.join(' ')}\``, `\`${neu.hist.join(' ')}\``);
line('Attention mean (unchanged prompt)', old.attMean, neu.attMean);
line('Blocks ≥7 for 2+ goals (of 129)', old.multiGoalHigh, neu.multiGoalHigh);
for (const k of Object.keys(old.sensitivity) as (keyof typeof old.sensitivity)[]) line(`Sensitivity: ${k}`, old.sensitivity[k], neu.sensitivity[k]);
for (const k of Object.keys(old.playback) as (keyof typeof old.playback)[]) line(`Playback: ${k}`, old.playback[k], neu.playback[k]);
for (const k of Object.keys(old.latency) as (keyof typeof old.latency)[]) line(`Latency: ${k}`, old.latency[k], neu.latency[k]);
md.push('', '| Run | judge ≥7 | old GM ≥7 | old prec | old rec | old FH | new GM ≥7 | new prec | new rec | new FH |', '|---|---|---|---|---|---|---|---|---|---|');
for (const r of perRun) md.push(`| ${r.video}-${r.goal} | ${r.judgeHigh} | ${r.old.gmHigh} | ${r.old.prec ?? '–'} | ${r.old.rec ?? '–'} | ${r.old.fh} | ${r.neu.gmHigh} | ${r.neu.prec ?? '–'} | ${r.neu.rec ?? '–'} | ${r.neu.fh} |`);
md.push('', `Transitions: ${JSON.stringify(transitions)}`, '');
if (categories) {
  md.push('## Categories chosen by Nano', '', '| Category | count | % | judge mean | judge ≤3 | judge ≥7 |', '|---|---|---|---|---|---|');
  for (const c of CATS) {
    const j = (categories.judgeByCategory as any)[c];
    md.push(`| ${c} | ${(categories.overall as any)[c]} | ${(categories.overallPct as any)[c]} | ${j.judgeMean ?? '–'} | ${j.judgeLe3} | ${j.judgeGe7} |`);
  }
  md.push('', '| Run | ' + CATS.join(' | ') + ' |', '|---|' + CATS.map(() => '---').join('|') + '|');
  for (const [k, c] of Object.entries(categories.perRun)) md.push(`| ${k} | ${CATS.map((x) => (c as any)[x]).join(' | ')} |`);
  md.push('', `Blocks changing category between goals: ${categories.blocksChangingCategoryPct}%`, `High-set (important|essential) Jaccard between goals: mean ${categories.highSetJaccard.mean}, max ${categories.highSetJaccard.max} (baseline numeric ≥7: mean ${oldHighSetJaccard.mean}, max ${oldHighSetJaccard.max})`, '');
  md.push(`\n## goalSwings (${goalSwings.length})\n`);
  for (const rs of goalSwings) md.push(`- ${rs[0]!.video} #${rs[0]!.index} (${rs[0]!.time}): ${rs.map((r) => `${r.goal}=${r.neu.relevanceCategory} (J${r.j}, old R${r.old.relevance})`).join(', ')}. Text: "${excerpt(rs[0]!.old.text, 160)}"`);
}
for (const [k, list] of Object.entries(examples)) {
  md.push(`\n## ${k} (${list.length})\n`);
  for (const e of list) md.push(`- ${e.video}-${e.goal} #${e.index} (${e.time}) judge ${e.judge}: old R${e.old.relevance} "${e.old.reason}" → new R${e.new.relevance}/A${e.new.attention} ${e.new.speed}× "${e.new.reason}". Text: "${e.text}"`);
}
writeFileSync(`${NEW}/compare.md`, md.join('\n') + '\n');
console.log(md.slice(0, 60).join('\n'));
