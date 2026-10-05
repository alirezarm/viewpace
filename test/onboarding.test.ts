import { describe, expect, it } from 'vitest';
import { SMART_PACING_COPY, shouldAutoEnable, smartPacingState, type Onboarding } from '../src/shared/onboarding';

const fresh: Onboarding = { welcomed: true, modeChosenByUser: false, autoEnabledAt: null, lastSetupError: null };

describe('smartPacingState', () => {
  it('maps availability to user-facing states', () => {
    expect(smartPacingState('available', 'ai')).toBe('on');
    expect(smartPacingState('available', 'baseline')).toBe('off-by-choice');
    expect(smartPacingState('downloadable', 'baseline')).toBe('offer');
    expect(smartPacingState('downloading', 'ai')).toBe('downloading');
    for (const s of ['unavailable', 'unsupported', 'error', 'disabled'] as const) {
      expect(smartPacingState(s, 'baseline')).toBe('unavailable');
    }
  });
});

describe('shouldAutoEnable', () => {
  it('switches on when the model becomes ready', () => {
    expect(shouldAutoEnable('available', 'baseline', fresh)).toBe(true);
  });
  it('never overrides a mode the user picked', () => {
    expect(shouldAutoEnable('available', 'baseline', { ...fresh, modeChosenByUser: true })).toBe(false);
  });
  it('does nothing when not ready or already on', () => {
    expect(shouldAutoEnable('downloadable', 'baseline', fresh)).toBe(false);
    expect(shouldAutoEnable('downloading', 'baseline', fresh)).toBe(false);
    expect(shouldAutoEnable('available', 'ai', fresh)).toBe(false);
  });
});

describe('copy', () => {
  it('never uses technical terms in user-facing text', () => {
    const banned = /LanguageModel|Prompt API|service worker|session|Gemini|Nano|model/i;
    for (const c of Object.values(SMART_PACING_COPY)) {
      expect(`${c.title} ${c.body} ${c.action ?? ''}`).not.toMatch(banned);
    }
  });
  it('offers exactly one action, and only when a download is needed', () => {
    const withAction = Object.entries(SMART_PACING_COPY).filter(([, c]) => c.action);
    expect(withAction.map(([k]) => k)).toEqual(['offer']);
  });
});
