import { describe, expect, it } from 'vitest';
import { describeChange, type ChangeContext } from '../src/content/friendly';

const base: ChangeContext = { previousRate: 1.5, rate: 1.25, mode: 'ai', aiScore: null, aiMean: null, pauseRatio: 0, littleSpeech: false };

describe('describeChange', () => {
  it('credits harder content when the AI score is well above the video average', () => {
    expect(describeChange({ ...base, aiScore: 8, aiMean: 6 })).toBe('Slowing down for a harder part');
  });
  it('falls back to speaking speed when the AI score is near average', () => {
    expect(describeChange({ ...base, aiScore: 6, aiMean: 5.6 })).toBe('Slowing down for a fast speaker');
  });
  it('ignores AI scores in speech-only mode', () => {
    expect(describeChange({ ...base, mode: 'baseline', aiScore: 9, aiMean: 2 })).toBe('Slowing down for a fast speaker');
  });
  it('explains speed-ups', () => {
    const up = { ...base, previousRate: 1.2, rate: 1.45 };
    expect(describeChange({ ...up, aiScore: 3, aiMean: 5 })).toBe('Speeding up through an easier part');
    expect(describeChange({ ...up, pauseRatio: 0.3 })).toBe('Speeding up through pauses');
    expect(describeChange(up)).toBe('Speeding up for a slow speaker');
    expect(describeChange({ ...up, littleSpeech: true })).toBe('Speeding up: no one is talking');
  });
});
