/**
 * Evaluation-only: how dense the Goal Map is for a completed mapping. Rebuilds the map from a saved
 * run with the production GoalMap / goalTimeline / mergeSegments (so the numbers are what the badge
 * draws) and reports blocks vs drawn regions, region lengths and speed changes.
 *
 *   npx esbuild eval/goal-mode/map-density.ts --bundle --platform=node --format=esm --outfile=/tmp/md.mjs
 *   node /tmp/md.mjs eval-results/goal-mode-poc1.5/runs/zjkBMFhNj_g-A.json [more runs…]
 *
 * Changes nothing in Goal Mode.
 */
import { readFileSync } from 'node:fs';
import { PROFILES } from '../../src/content/controller';
import { GoalMap } from '../../src/content/goal/goal-map';
import { goalTimeline, timelineClock } from '../../src/content/goal/goal-timeline';

interface RunBlock {
  index: number;
  start: number;
  end: number;
  text: string;
  topic: string | null;
  relevance: number | null;
  attention: number | null;
  reason: string | null;
}

const pace = PROFILES.normal;
const r2 = (x: number) => Math.round(x * 100) / 100;
const pctl = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const min = (x: number) => `${r2(x / 60)} min`;

export function density(file: string): string {
  const run = JSON.parse(readFileSync(file, 'utf8')).result as { goal: string; title: string; blocks: RunBlock[]; transcript: { endSec: number } };
  const map = new GoalMap(run.blocks.map((b) => ({ index: b.index, start: b.start, end: b.end, text: b.text })));
  for (const b of run.blocks) {
    if (b.relevance === null || b.attention === null) map.setFailed(b.index);
    else map.setRating(b.index, { topic: b.topic ?? '', relevance: b.relevance, attention: b.attention, reason: b.reason ?? '' });
  }
  const end = run.blocks.at(-1)!.end;
  const tl = goalTimeline(map, pace, end, 0, false);
  const blocks = tl.segments.filter((s) => s.state !== 'none');
  const regions = tl.regions;
  const lens = regions.map((r) => r.end - r.start);
  const speed = (r: { state: string; rate?: number }) => (r.state === 'mapped' ? `${Number(r.rate!.toFixed(2))}×` : r.state);

  const perSpeed = new Map<string, { regions: number; blocks: number; sec: number }>();
  for (const r of regions) {
    const k = speed(r);
    const e = perSpeed.get(k) ?? { regions: 0, blocks: 0, sec: 0 };
    e.regions++;
    e.blocks += r.blocks;
    e.sec += r.end - r.start;
    perSpeed.set(k, e);
  }
  const changes = blocks.slice(1).filter((s, i) => speed(s) !== speed(blocks[i]!)).length;
  // How far apart the speeds of neighbouring blocks are, in pacing rows (0 = same).
  const steps = blocks.slice(1).map((s, i) => (s.state === 'mapped' && blocks[i]!.state === 'mapped' ? Math.abs(s.level! - blocks[i]!.level!) : null)).filter((x): x is number => x !== null);
  const singleBlock = regions.filter((r) => r.blocks === 1).length;
  // A–B–A flicker: a one-block region whose neighbours share a speed different from its own.
  const flicker = regions.filter((r, i) => r.blocks === 1 && i > 0 && i < regions.length - 1 && speed(regions[i - 1]!) === speed(regions[i + 1]!)).length;
  const blockLens = blocks.map((s) => s.end - s.start);

  const out: string[] = [];
  out.push(`# ${run.title}`, `Goal: ${run.goal}`, '');
  out.push(`1. Blocks: ${blocks.length} (length median ${min(median(blockLens))}, range ${min(Math.min(...blockLens))}–${min(Math.max(...blockLens))})`);
  out.push(`2. Drawn regions: ${regions.length}`);
  out.push(`3. Reduction: ${blocks.length} → ${regions.length} (×${r2(blocks.length / regions.length)}; ${Math.round((1 - regions.length / blocks.length) * 100)}% fewer pieces)`);
  out.push(`4. By speed:`);
  for (const [k, v] of [...perSpeed].sort()) out.push(`   ${k.padEnd(7)} ${String(v.regions).padStart(3)} regions, ${String(v.blocks).padStart(3)} blocks, ${min(v.sec)}`);
  out.push(`5. Region length: min ${min(Math.min(...lens))}, median ${min(median(lens))}, mean ${min(lens.reduce((a, b) => a + b, 0) / lens.length)}, p90 ${min(pctl(lens, 0.9))}, max ${min(Math.max(...lens))}`);
  const bucket = (lo: number, hi: number) => lens.filter((l) => l >= lo * 60 && l < hi * 60).length;
  out.push(`6. Regions <1 min: ${bucket(0, 1)}, 1–2 min: ${bucket(1, 2)}, 2–5 min: ${bucket(2, 5)}, >5 min: ${bucket(5, Infinity)}`);
  out.push(`7. Speed changes between consecutive blocks: ${changes} of ${blocks.length - 1} (${Math.round((changes / (blocks.length - 1)) * 100)}%)`);
  out.push(`   Size of each change (pacing rows): ${[1, 2, 3, 4].map((d) => `${d}: ${steps.filter((x) => x === d).length}`).join(', ')}`);
  out.push(`   One-block regions: ${singleBlock} of ${regions.length}; A–B–A flickers (one block between two of the same speed): ${flicker}`);
  out.push(`8. Regions:`);
  for (const r of regions) {
    const topics = [...new Set(r.topics.map((t) => t.trim()).filter(Boolean))];
    out.push(`   ${`${timelineClock(r.start)}–${timelineClock(r.end)}`.padEnd(13)} ${speed(r).padEnd(7)} ${String(r.blocks).padStart(2)} blk  ${topics.slice(0, 3).join(' / ')}${topics.length > 3 ? ` +${topics.length - 3}` : ''}`);
  }
  return out.join('\n');
}

for (const f of process.argv.slice(2)) console.log(density(f) + '\n');
