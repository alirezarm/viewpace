/**
 * Goal Mode: the compact whole-video timeline. A pure view of the map, so it can be tested
 * without the DOM: one segment per block, in time order, plus any stretch with no captions.
 *
 * What a segment says is the pacing Goal Mode will apply there, not raw scores: `level` is the
 * pacing row (0 = slowest, for the key parts of the goal … 4 = fastest). Parts not mapped yet are
 * their own state and never look like low relevance.
 */
import type { Profile } from '../controller';
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
 * A stretch of the map drawn as one piece: consecutive blocks with the same state and, when mapped,
 * the same pacing (so the same speed). Display only: playback always uses each block's own rating.
 */
export interface TimelineRegion {
  start: number;
  end: number;
  state: TimelineState;
  level?: number;
  label?: string;
  rate?: number;
  /** The underlying blocks' own topics, in time order (as rated; may repeat or be empty). */
  topics: string[];
  /** How many segments were merged into this region. */
  blocks: number;
}

/**
 * Merge runs of neighbouring segments that look the same on the map: same state, and for mapped
 * parts the same pacing row. A mapped run never merges across an unmapped or failed part, so the
 * map regroups naturally as blocks are rated.
 */
export function mergeSegments(segments: TimelineSegment[]): TimelineRegion[] {
  const out: TimelineRegion[] = [];
  for (const s of segments) {
    const last = out[out.length - 1];
    if (last && last.state === s.state && last.level === s.level && last.end === s.start) {
      last.end = s.end;
      last.blocks++;
      if (s.topic !== undefined) last.topics.push(s.topic);
      continue;
    }
    out.push({ start: s.start, end: s.end, state: s.state, level: s.level, label: s.label, rate: s.rate, topics: s.topic !== undefined ? [s.topic] : [], blocks: 1 });
  }
  return out;
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
    regions: mergeSegments(segments),
  };
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
  const distinct: string[] = [];
  for (const t of r.topics) {
    const topic = t.trim().replace(/\s+/g, ' ');
    if (topic && !distinct.some((d) => d.toLowerCase() === topic.toLowerCase())) distinct.push(topic);
  }
  const detail = [r.label, r.rate !== undefined ? `${Number(r.rate.toFixed(2))}×` : ''].filter(Boolean).join(' · ');
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
