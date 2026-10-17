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
  segments: TimelineSegment[];
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

/** What the Goal Map's hover card says about one part: when, what it's about, and what Goal Mode does there. */
export interface SegmentTooltip {
  range: string; // e.g. "13:22–14:05"
  /** The block's topic, the card's main line; null when there isn't one (never invented). */
  topic: string | null;
  /** e.g. "Key part for your goal · 1×", or the state of a part that isn't analyzed. */
  detail: string;
}

export function segmentTooltip(s: TimelineSegment): SegmentTooltip {
  const range = `${clock(s.start)}–${clock(s.end)}`;
  if (s.state === 'pending') return { range, topic: null, detail: 'Not analyzed yet' };
  if (s.state === 'failed') return { range, topic: null, detail: "Couldn't be analyzed" };
  if (s.state === 'none') return { range, topic: null, detail: 'No captions' };
  const topic = s.topic?.trim() || null;
  const detail = [s.label, s.rate !== undefined ? `${Number(s.rate.toFixed(2))}×` : ''].filter(Boolean).join(' · ');
  return { range, topic, detail };
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
