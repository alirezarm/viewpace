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

/** Compact hover detail for one segment, e.g. "18:40–20:05 · Evaluation metrics · Important for your goal · 1.15×". */
export function segmentDetail(s: TimelineSegment): string {
  const range = `${clock(s.start)}–${clock(s.end)}`;
  if (s.state === 'pending') return `${range}\nNot mapped yet: speed unchanged for now`;
  if (s.state === 'failed') return `${range}\nCouldn't be mapped: speed unchanged`;
  if (s.state === 'none') return `${range}\nNo captions: not mapped`;
  return [range, s.topic, s.label, s.rate !== undefined ? `${Number(s.rate.toFixed(2))}×` : ''].filter(Boolean).join('\n');
}
