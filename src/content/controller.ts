import type { Mode, ProfileName, SpeechFeatures } from '../shared/types';

export interface Profile {
  minRate: number;
  maxRate: number;
  /** Comfortable *effective* listening speed while someone is talking (articulation wpm × playbackRate). */
  targetWpm: number;
  /** Rate used when there is little or no speech to measure. */
  defaultRate: number;
}

export const PROFILES: Record<ProfileName, Profile> = {
  relaxed: { minRate: 1.0, maxRate: 1.5, targetWpm: 200, defaultRate: 1.15 },
  normal: { minRate: 1.0, maxRate: 2.0, targetWpm: 250, defaultRate: 1.35 },
  fast: { minRate: 1.1, maxRate: 2.5, targetWpm: 320, defaultRate: 1.6 },
};

export const CONTROL = {
  /** Minimum wall-clock time between decisions (and therefore between speed changes). */
  minIntervalMs: 7000,
  /** Ignore target/current differences smaller than this. */
  hysteresis: 0.1,
  /** A change in the opposite direction of the previous one within this time needs 2× hysteresis. */
  reversalWindowMs: 21000,
  /** Largest single slow-down: react quickly when dense content arrives. */
  maxStepDown: 0.5,
  /** Largest single speed-up: speed up gradually. */
  maxStepUp: 0.25,
  quantum: 0.05,
  /** Below this many words in the window we don't trust speech-rate estimates. */
  minWords: 8,
  /** Extra speed-up per unit of pause ratio (pauses are silence, cheap to compress)… */
  pauseBonusPerRatio: 0.5,
  /** …capped at this fraction. */
  pauseBonusMax: 0.25,
  /**
   * How strongly AI complexity scales the comfortable wpm. The score is judged relative to this
   * video's running average: factor = 1 − 2·aiWeight·(score − mean), clamped to 1 ± aiWeight.
   */
  aiWeight: 0.2,
  /** Starting guess for a video's average complexity (0..1) before real scores arrive. */
  aiPriorMean: 0.5,
  /** The starting guess counts as this many chunks, so the first scores can't swing the average. */
  aiPriorWeight: 3,
  /** Once enough chunks are in, the average becomes a moving average with this weight per chunk. */
  aiMeanAlpha: 0.1,
};

export interface Signals {
  features: SpeechFeatures | null;
  /** Normalized AI complexity 0..1, or null when unavailable/pending. */
  complexity: number | null;
  /** This video's running average complexity 0..1 (see videoMean). Defaults to the prior. */
  complexityMean?: number;
}

/**
 * The video's reference complexity, given its chunk scores in playback order.
 * Early on it is a plain average blended with a prior (so one or two chunks can't swing it);
 * once the per-chunk weight would drop below aiMeanAlpha it becomes a moving average, so it
 * follows a video that gets harder or easier over time.
 */
export function videoMean(scoresInOrder: number[]): number {
  let m = CONTROL.aiPriorMean;
  scoresInOrder.forEach((c, i) => {
    const alpha = Math.max(1 / (CONTROL.aiPriorWeight + i + 1), CONTROL.aiMeanAlpha);
    m += alpha * (c - m);
  });
  return m;
}

export interface Target {
  rate: number;
  reason: string;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
export const quantize = (x: number) => Math.round(x / CONTROL.quantum) * CONTROL.quantum;
const fmt = (x: number) => x.toFixed(2);

/** Map signals to a desired playback rate (no smoothing / rate limiting here). */
export function computeTarget(signals: Signals, profileName: ProfileName, mode: Mode): Target {
  const p = PROFILES[profileName];
  const f = signals.features;

  if (!f) return { rate: p.defaultRate, reason: 'no transcript → profile default' };
  if (f.words < CONTROL.minWords) {
    const why = f.nonSpeechTags > 0 ? 'music/non-speech' : 'little speech';
    return { rate: p.defaultRate, reason: `${why} (${f.words} words) → profile default` };
  }

  // Speed is based on how fast the person talks *while talking*, so a fast speaker who pauses a
  // lot isn't mistaken for a slow one. Pauses get a separate, capped speed-up.
  let comfortWpm = p.targetWpm;
  const talkingWpm = Math.max(1, f.articulationWpm);
  const pauseBonus = Math.min(CONTROL.pauseBonusMax, CONTROL.pauseBonusPerRatio * f.pauseRatio);
  const parts = [`${Math.round(talkingWpm)} wpm talking`];
  if (pauseBonus >= 0.01) parts.push(`${Math.round(f.pauseRatio * 100)}% pauses → +${Math.round(pauseBonus * 100)}%`);

  if (mode === 'ai') {
    if (signals.complexity !== null) {
      const mean = signals.complexityMean ?? CONTROL.aiPriorMean;
      const factor = clamp(1 - 2 * CONTROL.aiWeight * (signals.complexity - mean), 1 - CONTROL.aiWeight, 1 + CONTROL.aiWeight);
      comfortWpm *= factor;
      parts.push(`AI ${Math.round(signals.complexity * 10)}/10 vs avg ${(mean * 10).toFixed(1)} → ×${fmt(factor)}`);
    } else {
      parts.push('AI pending → speech only');
    }
  }

  const raw = (comfortWpm / talkingWpm) * (1 + pauseBonus);
  const rate = clamp(raw, p.minRate, p.maxRate);
  let reason = `${parts.join(', ')}; target ${Math.round(comfortWpm)} eff. wpm → ${fmt(raw)}×`;
  if (rate !== raw) reason += ` (clamped ${fmt(rate)}×)`;
  return { rate, reason };
}

export interface ControllerState {
  current: number;
  lastDecisionAt: number; // -Infinity before the first decision
  lastChangeAt: number;
  lastDirection: -1 | 0 | 1;
}

export function initialState(currentRate: number): ControllerState {
  return { current: currentRate, lastDecisionAt: -Infinity, lastChangeAt: -Infinity, lastDirection: 0 };
}

export interface Decision {
  previousRate: number;
  rate: number;
  changed: boolean;
  why: string;
}

/**
 * Advance the controller by one tick. Makes a decision at most every CONTROL.minIntervalMs,
 * applying hysteresis, a reversal guard and asymmetric step limits (fast down, slow up).
 * No extra smoothing: the 20 s analysis window already smooths the target.
 */
export function step(
  prev: ControllerState,
  targetRate: number,
  now: number,
): { state: ControllerState; decision: Decision | null } {
  const state: ControllerState = { ...prev };

  if (now - prev.lastDecisionAt < CONTROL.minIntervalMs) return { state, decision: null };
  state.lastDecisionAt = now;

  const delta = targetRate - prev.current;
  const direction: -1 | 0 | 1 = delta > 0 ? 1 : delta < 0 ? -1 : 0;
  const reversing =
    prev.lastDirection !== 0 && direction === -prev.lastDirection && now - prev.lastChangeAt < CONTROL.reversalWindowMs;
  const threshold = reversing ? 2 * CONTROL.hysteresis : CONTROL.hysteresis;

  if (Math.abs(delta) < threshold - 1e-9) {
    const why = reversing
      ? `hold: reversal guard (Δ${fmt(delta)} < ${fmt(threshold)})`
      : `hold: within hysteresis (Δ${fmt(delta)})`;
    return { state, decision: { previousRate: prev.current, rate: prev.current, changed: false, why } };
  }

  const stepped = clamp(delta, -CONTROL.maxStepDown, CONTROL.maxStepUp);
  const rate = Number(quantize(prev.current + stepped).toFixed(2));
  if (rate === prev.current) {
    return { state, decision: { previousRate: prev.current, rate, changed: false, why: 'hold: below quantum' } };
  }
  state.current = rate;
  state.lastChangeAt = now;
  state.lastDirection = direction;
  const why = stepped !== delta ? `change limited to ${fmt(stepped)}` : 'change';
  return { state, decision: { previousRate: prev.current, rate, changed: true, why } };
}
