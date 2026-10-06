/**
 * Local-only beta usage counters: a fixed-size record (no per-event log, no transcript text).
 * Together with the bounded feedback log, they feed the Beta Summary under Advanced.
 */
import type { DecisionLogEntry } from './types';

/** Whether a speed decision actually used the content (AI) score, not just the mode setting. */
export type Analysis = 'speech' | 'content';
export const ANALYSES: Analysis[] = ['speech', 'content'];

export interface AnalysisCounters {
  /** Wall-clock seconds of playback while ViewPace was in control of the speed. */
  playSec: number;
  /** Sum of playbackRate × seconds over that time (for a time-weighted average speed). */
  rateSec: number;
  /** Videos on which ViewPace changed the speed at least once. */
  videos: number;
  /** Speed changes by the user (or another tool) while ViewPace was in control. */
  overrides: number;
  /** Of those, how many went back to ViewPace's speed by themselves (e.g. press-and-hold). */
  temporary: number;
}

export interface UsageStats {
  since: number;
  byAnalysis: Record<Analysis, AnalysisCounters>;
}

export const STATS_KEY = 'autospeed.stats';

export const emptyCounters = (): AnalysisCounters => ({ playSec: 0, rateSec: 0, videos: 0, overrides: 0, temporary: 0 });
export const emptyStats = (now: number): UsageStats => ({
  since: now,
  byAnalysis: { speech: emptyCounters(), content: emptyCounters() },
});

/** A decision used content analysis only if an AI score was available for it. */
export function analysisOf(e: Pick<DecisionLogEntry, 'mode' | 'aiScore'>): Analysis {
  return e.mode === 'ai' && e.aiScore !== null ? 'content' : 'speech';
}

export function mergeStats(base: UsageStats, delta: Record<Analysis, AnalysisCounters>): UsageStats {
  const out: UsageStats = { since: base.since, byAnalysis: { speech: { ...base.byAnalysis.speech }, content: { ...base.byAnalysis.content } } };
  for (const a of ANALYSES) {
    for (const k of Object.keys(delta[a]) as (keyof AnalysisCounters)[]) out.byAnalysis[a][k] += delta[a][k];
  }
  return out;
}

// ---------- in-memory meter (content script) ----------

/** Longest gap between two ticks still counted as playback (background tabs are throttled). */
const MAX_TICK_GAP_SEC = 2;

export class UsageMeter {
  private delta: Record<Analysis, AnalysisCounters> = { speech: emptyCounters(), content: emptyCounters() };
  private lastTick: number | null = null;

  /** Call every tick. Counts time only while playing with ViewPace in control. */
  tick(now: number, counting: boolean, rate: number, analysis: Analysis): void {
    const prev = this.lastTick;
    this.lastTick = now;
    if (!counting || prev === null) return;
    const sec = Math.min(MAX_TICK_GAP_SEC, Math.max(0, (now - prev) / 1000));
    this.delta[analysis].playSec += sec;
    this.delta[analysis].rateSec += sec * rate;
  }

  videoAdapted(analysis: Analysis): void {
    this.delta[analysis].videos++;
  }

  override(analysis: Analysis): void {
    this.delta[analysis].overrides++;
  }

  temporaryOverride(analysis: Analysis): void {
    this.delta[analysis].temporary++;
  }

  /** Counters accumulated since the last call (then reset), or null if nothing happened. */
  takeDelta(): Record<Analysis, AnalysisCounters> | null {
    const d = this.delta;
    this.delta = { speech: emptyCounters(), content: emptyCounters() };
    const empty = ANALYSES.every((a) => Object.values(d[a]).every((v) => v === 0));
    return empty ? null : d;
  }
}

// ---------- summary (popup) ----------

export interface SummaryColumn {
  feedback: number;
  justRight: number | null; // share 0..1, null without feedback
  tooSlow: number | null;
  tooFast: number | null;
  avgSpeed: number | null; // time-weighted, null without enough playback
  playMinutes: number;
  videos: number;
  /** Lasting overrides (temporary ones excluded). */
  overrides: number;
  overridesPerVideo: number | null;
}

export interface BetaSummary {
  since: number | null;
  total: SummaryColumn;
  byAnalysis: Record<Analysis, SummaryColumn>;
}

/** Below this much playback an average speed isn't meaningful. */
export const MIN_PLAY_SEC_FOR_SPEED = 60;

function column(feedback: DecisionLogEntry[], c: AnalysisCounters): SummaryColumn {
  const n = feedback.length;
  const share = (f: string) => (n ? feedback.filter((e) => e.feedback === f).length / n : null);
  const overrides = Math.max(0, c.overrides - c.temporary);
  return {
    feedback: n,
    justRight: share('good'),
    tooSlow: share('too_slow'),
    tooFast: share('too_fast'),
    avgSpeed: c.playSec >= MIN_PLAY_SEC_FOR_SPEED ? c.rateSec / c.playSec : null,
    playMinutes: c.playSec / 60,
    videos: c.videos,
    overrides,
    overridesPerVideo: c.videos ? overrides / c.videos : null,
  };
}

export function summarize(log: DecisionLogEntry[], stats: UsageStats | null): BetaSummary {
  const rated = log.filter((e) => e.feedback !== null);
  const counters = stats?.byAnalysis ?? { speech: emptyCounters(), content: emptyCounters() };
  const total = ANALYSES.reduce((acc, a) => {
    for (const k of Object.keys(acc) as (keyof AnalysisCounters)[]) acc[k] += counters[a][k];
    return acc;
  }, emptyCounters());
  return {
    since: stats?.since ?? null,
    total: column(rated, total),
    byAnalysis: {
      speech: column(rated.filter((e) => analysisOf(e) === 'speech'), counters.speech),
      content: column(rated.filter((e) => analysisOf(e) === 'content'), counters.content),
    },
  };
}

// ---------- storage ----------

let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => undefined);
  return next;
}

export async function loadStats(): Promise<UsageStats | null> {
  const got = await chrome.storage.local.get(STATS_KEY);
  return (got[STATS_KEY] as UsageStats | undefined) ?? null;
}

/** Add counters to the stored record (fixed size, so storage stays bounded). */
export function addStats(delta: Record<Analysis, AnalysisCounters>, now = Date.now()): Promise<void> {
  return serial(async () => {
    const current = (await loadStats()) ?? emptyStats(now);
    await chrome.storage.local.set({ [STATS_KEY]: mergeStats(current, delta) });
  });
}

export function clearStats(): Promise<void> {
  return serial(() => chrome.storage.local.remove(STATS_KEY));
}
