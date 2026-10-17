/**
 * Goal Mode: the compact whole-video timeline. A pure view of the map, so it can be tested
 * without the DOM: one segment per block, in time order, plus any stretch with no captions.
 *
 * What a segment says is the pacing Goal Mode will apply there, not raw scores: `level` is the
 * pacing row (0 = slowest, for the key parts of the goal … 4 = fastest). Parts not mapped yet are
 * their own state and never look like low relevance.
 */
import { PROFILES, type Profile } from '../controller';
import { MAX_LABEL_REGIONS, MAX_REGION_TOPICS, type RegionTopics } from '../../shared/goal-prompt';
import type { GoalMap } from './goal-map';
import { GOAL_PACING, goalTarget, pacingLevel } from './goal-pacing';

export type TimelineState =
  | 'mapped' // rated: Goal Mode paces this part
  | 'pending' // not rated yet: speed left alone until it is
  | 'failed' // couldn't be rated: speed left alone
  | 'none'; // no captions here: nothing to map

export interface TimelineSegment {
  start: number; // seconds
  end: number;
  state: TimelineState;
  /** Mapped only: pacing row, 0 (slowest) … LEVELS - 1 (fastest). */
  level?: number;
  /** Mapped only: what the row means for the goal, e.g. "Important for your goal". */
  label?: string;
  /** Mapped only: the speed Goal Mode targets here. */
  rate?: number;
  /** Mapped only: what the part is about. */
  topic?: string;
}

export interface GoalTimeline {
  duration: number;
  /** Current playback position, clamped to [0, duration]. */
  position: number;
  /** Share of blocks attempted so far (rated or failed), 0..1. */
  progress: number;
  mapping: boolean;
  /** One per block (plus any caption-less tail): what Goal Mode knows. */
  segments: TimelineSegment[];
  /** What the map draws: runs of neighbouring segments merged by `mergeSegments` (display only). */
  regions: TimelineRegion[];
}

/**
 * Visual tiers: the map draws Goal Mode's five speeds as three, so one-step speed changes between
 * neighbouring blocks don't turn it into a barcode. Index = pacing row (GOAL_PACING), value = tier:
 * 0 = slow (key / important), 1 = medium (relevant background), 2 = fast (less / not relevant).
 * Display only: playback always uses each block's own speed.
 */
const ROW_TIER = [0, 0, 1, 2, 2];
export const VISUAL_TIERS = 3;
export function visualTier(level: number): number {
  return ROW_TIER[Math.min(ROW_TIER.length - 1, Math.max(0, level))]!;
}

/**
 * A stretch of the map drawn as one piece (display only; playback uses each block's own rating).
 * Mapped regions may hold blocks with different actual speeds; `parts` keeps them all.
 */
export interface TimelineRegion {
  start: number;
  end: number;
  state: TimelineState;
  /** Mapped only: visual tier, 0 (slow) … VISUAL_TIERS - 1 (fast). */
  tier?: number;
  /** Mapped only: the meaning covering most of the region's time (ties: the slower one). */
  label?: string;
  /** Mapped only: the actual speeds Goal Mode uses inside the region. */
  minRate?: number;
  maxRate?: number;
  /** The underlying blocks' own topics, in time order (as rated; may repeat or be empty). */
  topics: string[];
  /** How many segments were merged into this region. */
  blocks: number;
  /** The segments drawn as this region, unchanged. */
  parts: TimelineSegment[];
  /** Once the map is complete: a short name for what the region is about (presentation only). */
  name?: string;
}

/** A region's identity on a completed map: its time range (boundaries never change once every block is done). */
export const regionKey = (r: { start: number; end: number }) => `${r.start}|${r.end}`;

const tierOf = (s: TimelineSegment) => (s.state === 'mapped' ? visualTier(s.level ?? 0) : undefined);

function region(parts: TimelineSegment[], tier: number | undefined): TimelineRegion {
  const first = parts[0]!;
  const r: TimelineRegion = {
    start: first.start,
    end: parts[parts.length - 1]!.end,
    state: first.state,
    topics: parts.filter((p) => p.topic !== undefined).map((p) => p.topic!),
    blocks: parts.length,
    parts,
  };
  if (first.state !== 'mapped') return r;
  const rates = parts.map((p) => p.rate!).filter((x) => x !== undefined);
  const time = new Map<string, { sec: number; level: number }>();
  for (const p of parts) {
    const e = time.get(p.label ?? '') ?? { sec: 0, level: p.level ?? 0 };
    e.sec += p.end - p.start;
    time.set(p.label ?? '', e);
  }
  const label = [...time].sort((a, b) => b[1].sec - a[1].sec || a[1].level - b[1].level)[0]![0];
  return { ...r, tier, label: label || undefined, minRate: Math.min(...rates), maxRate: Math.max(...rates) };
}

/**
 * Group segments into what the map draws (display only):
 *  1. merge runs of neighbours with the same state and, when mapped, the same visual tier;
 *  2. absorb a single mapped block of another tier sitting between two regions of one tier (A–B–A
 *     becomes one A region). Longer runs are kept.
 * Mapped regions never merge across an unmapped or failed part, so the map regroups naturally as
 * blocks are rated.
 */
export function mergeSegments(segments: TimelineSegment[]): TimelineRegion[] {
  const runs: { parts: TimelineSegment[]; tier: number | undefined }[] = [];
  for (const s of segments) {
    const last = runs[runs.length - 1];
    const lastPart = last?.parts[last.parts.length - 1];
    if (last && lastPart!.state === s.state && last.tier === tierOf(s) && lastPart!.end === s.start) last.parts.push(s);
    else runs.push({ parts: [s], tier: tierOf(s) });
  }
  const out: { parts: TimelineSegment[]; tier: number | undefined }[] = [];
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]!;
    const prev = out[out.length - 1];
    const next = runs[i + 1];
    const flicker =
      run.parts.length === 1 &&
      run.tier !== undefined &&
      prev?.tier !== undefined &&
      next?.tier !== undefined &&
      prev.tier === next.tier &&
      prev.tier !== run.tier;
    if (flicker) {
      prev!.parts.push(...run.parts, ...next!.parts);
      i++; // `next` is now part of `prev`
      continue;
    }
    out.push({ parts: [...run.parts], tier: run.tier });
  }
  return out.map((r) => region(r.parts, r.tier));
}

export const LEVELS = GOAL_PACING.length;

export function goalTimeline(map: GoalMap, pace: Profile, duration: number, position: number, mapping: boolean): GoalTimeline {
  const blocks = map.blocks;
  const end = blocks.length ? blocks[blocks.length - 1]!.end : 0;
  const total = Number.isFinite(duration) && duration > 0 ? Math.max(duration, end) : end;
  const segments: TimelineSegment[] = blocks.map((b) => {
    const r = map.rating(b.index);
    if (!r) return { start: b.start, end: b.end, state: map.done(b.index) ? 'failed' : 'pending' };
    const t = goalTarget(r, pace);
    return { start: b.start, end: b.end, state: 'mapped', level: pacingLevel(r), label: t.label, rate: t.rate, topic: r.topic };
  });
  if (total > end) segments.push({ start: end, end: total, state: 'none' });
  const attempted = blocks.filter((b) => map.done(b.index)).length;
  return {
    duration: total,
    position: Math.min(total, Math.max(0, position)),
    progress: blocks.length ? attempted / blocks.length : 0,
    mapping,
    segments,
    regions: mergeSegments(segments).map((r) => {
      const name = r.state === 'mapped' ? map.regionName(regionKey(r)) : undefined;
      return name ? { ...r, name } : r;
    }),
  };
}

/** Distinct, non-empty topics in time order (case and spacing ignored). */
function distinctTopics(topics: string[]): string[] {
  const out: string[] = [];
  for (const t of topics) {
    const topic = t.trim().replace(/\s+/g, ' ');
    if (topic && !out.some((d) => d.toLowerCase() === topic.toLowerCase())) out.push(topic);
  }
  return out;
}

/**
 * The one naming request for a completed map: its analyzed regions with their blocks' own topics,
 * bounded (the MAX_LABEL_REGIONS longest regions, MAX_REGION_TOPICS topics each) so it is always a
 * single call; regions left out keep their topic list. `keys` maps the request ids back to regions.
 */
export function regionLabelRequest(map: GoalMap): { regions: RegionTopics[]; keys: Map<string, string> } {
  // Region boundaries depend only on pacing rows, so any pace gives the same regions.
  const regions = goalTimeline(map, PROFILES.normal, 0, 0, false)
    .regions.filter((r) => r.state === 'mapped')
    .map((r) => ({ r, topics: distinctTopics(r.topics).slice(0, MAX_REGION_TOPICS) }))
    .filter((x) => x.topics.length > 0);
  const kept = [...regions]
    .sort((a, b) => b.r.end - b.r.start - (a.r.end - a.r.start))
    .slice(0, MAX_LABEL_REGIONS)
    .sort((a, b) => a.r.start - b.r.start);
  const keys = new Map<string, string>();
  const out: RegionTopics[] = kept.map((x, i) => {
    const id = String(i + 1);
    keys.set(id, regionKey(x.r));
    return { id, topics: x.topics };
  });
  return { regions: out, keys };
}

const clock = (t: number) => {
  const s = Math.max(0, Math.floor(t));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};
export { clock as timelineClock };

/** Topics listed on a hover card before the rest are summarised as "+N more". */
export const MAX_TOOLTIP_TOPICS = 3;

/** What the Goal Map's hover card says about one region: when, what it's about, and what Goal Mode does there. */
export interface RegionTooltip {
  range: string; // e.g. "12:40–15:55"
  /** The blocks' own topics, deduplicated, at most MAX_TOOLTIP_TOPICS; empty when there are none (never invented). */
  topics: string[];
  /** Distinct topics left out, shown as "+N more" (0 = none). */
  more: number;
  /** e.g. "Key part for your goal · 1×", or the state of a part that isn't analyzed. */
  detail: string;
}

export function regionTooltip(r: TimelineRegion): RegionTooltip {
  const range = `${clock(r.start)}–${clock(r.end)}`;
  if (r.state === 'pending') return { range, topics: [], more: 0, detail: 'Not analyzed yet' };
  if (r.state === 'failed') return { range, topics: [], more: 0, detail: "Couldn't be analyzed" };
  if (r.state === 'none') return { range, topics: [], more: 0, detail: 'No captions' };
  // Once named, the region's name replaces its list of block topics.
  const distinct = r.name ? [r.name] : distinctTopics(r.topics);
  const fmt = (x: number) => String(Number(x.toFixed(2)));
  const speed =
    r.minRate === undefined || r.maxRate === undefined ? '' : r.minRate === r.maxRate ? `${fmt(r.minRate)}×` : `${fmt(r.minRate)}–${fmt(r.maxRate)}×`;
  const detail = [r.label, speed].filter(Boolean).join(' · ');
  return { range, topics: distinct.slice(0, MAX_TOOLTIP_TOPICS), more: Math.max(0, distinct.length - MAX_TOOLTIP_TOPICS), detail };
}

// ---------- navigation: the Goal Map doubles as a seek bar ----------

/** Seeking exactly to the end would end the video, so a click at the far right lands just before it. */
const END_MARGIN_SEC = 0.5;

/** The video time for a point on the map, as a fraction of its width (clamped to the video). */
export function seekTimeAt(fraction: number, duration: number): number {
  if (!(duration > 0)) return 0;
  const f = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
  return Math.min(f * duration, Math.max(0, duration - END_MARGIN_SEC));
}

/**
 * Only a click (or tap) on the map seeks; hovering or moving over it never does.
 * Returns the time to seek to, or null for any other event.
 */
export function seekFromPointer(type: string, clientX: number, left: number, width: number, duration: number): number | null {
  if (type !== 'click' || !(width > 0)) return null;
  return seekTimeAt((clientX - left) / width, duration);
}

/** Keyboard on the focused map: arrows step 10 s, Page Up/Down 60 s, Home/End jump to the ends. */
export function seekFromKey(key: string, current: number, duration: number): number | null {
  const step: Record<string, number> = { ArrowLeft: -10, ArrowDown: -10, ArrowRight: 10, ArrowUp: 10, PageDown: -60, PageUp: 60 };
  if (key === 'Home') return 0;
  if (key === 'End') return seekTimeAt(1, duration);
  if (key in step) return seekTimeAt((current + step[key]!) / duration, duration);
  return null;
}
