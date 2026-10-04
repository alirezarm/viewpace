import type { Mode, ProfileName, SpeechFeatures } from '../shared/types';

export interface Profile {
  minRate: number;
  maxRate: number;
  /** Comfortable *effective* listening speed (spoken wpm × playbackRate). */
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
  /** Largest single speed change. */
  maxStep: 0.25,
  /** Exponential smoothing factor applied to the target on each tick (~1 s). */
  emaAlpha: 0.25,
  quantum: 0.05,
  /** Below this many words in the window we don't trust speech-rate estimates. */
  minWords: 8,
  /** How strongly AI complexity (0..1, centred at 0.5) scales the comfortable wpm: ±aiWeight. */
  aiWeight: 0.3,
};

export interface Signals {
  features: SpeechFeatures | null;
  /** Normalized AI complexity 0..1, or null when unavailable/pending. */
  complexity: number | null;
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

  let comfortWpm = p.targetWpm;
  const parts = [`${Math.round(f.wpm)} wpm`];
  if (f.pauseRatio >= 0.15) parts.push(`${Math.round(f.pauseRatio * 100)}% pauses`);

  if (mode === 'ai') {
    if (signals.complexity !== null) {
      const factor = 1 + CONTROL.aiWeight * (1 - 2 * signals.complexity);
      comfortWpm *= factor;
      parts.push(`AI ${Math.round(signals.complexity * 10)}/10 → ×${fmt(factor)}`);
    } else {
      parts.push('AI pending → speech only');
    }
  }

  const raw = comfortWpm / f.wpm;
  const rate = clamp(raw, p.minRate, p.maxRate);
  let reason = `${parts.join(', ')}; target ${Math.round(comfortWpm)} eff. wpm → ${fmt(raw)}×`;
  if (rate !== raw) reason += ` (clamped ${fmt(rate)}×)`;
  return { rate, reason };
}

export interface ControllerState {
  current: number;
  smoothed: number | null;
  lastDecisionAt: number; // -Infinity before the first decision
  lastChangeAt: number;
  lastDirection: -1 | 0 | 1;
}

export function initialState(currentRate: number): ControllerState {
  return { current: currentRate, smoothed: null, lastDecisionAt: -Infinity, lastChangeAt: -Infinity, lastDirection: 0 };
}

export interface Decision {
  previousRate: number;
  rate: number;
  changed: boolean;
  why: string;
}

/**
 * Advance the controller by one tick. Smooths the target every tick; makes a decision at most
 * every CONTROL.minIntervalMs, applying hysteresis, a reversal guard and a max step size.
 */
export function step(
  prev: ControllerState,
  targetRate: number,
  now: number,
): { state: ControllerState; decision: Decision | null } {
  const smoothed = prev.smoothed === null ? targetRate : prev.smoothed + CONTROL.emaAlpha * (targetRate - prev.smoothed);
  const state: ControllerState = { ...prev, smoothed };

  if (now - prev.lastDecisionAt < CONTROL.minIntervalMs) return { state, decision: null };
  state.lastDecisionAt = now;

  const delta = smoothed - prev.current;
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

  const stepped = clamp(delta, -CONTROL.maxStep, CONTROL.maxStep);
  const rate = Number(quantize(prev.current + stepped).toFixed(2));
  if (rate === prev.current) {
    return { state, decision: { previousRate: prev.current, rate, changed: false, why: 'hold: below quantum' } };
  }
  state.current = rate;
  state.lastChangeAt = now;
  state.lastDirection = direction;
  const why = stepped !== delta ? `change limited to ±${CONTROL.maxStep}` : 'change';
  return { state, decision: { previousRate: prev.current, rate, changed: true, why } };
}

/** External rate change (seek resets smoothing; user/YouTube sets the rate). */
export function resetSmoothing(s: ControllerState): ControllerState {
  return { ...s, smoothed: null };
}
