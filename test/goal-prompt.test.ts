import { describe, expect, it } from 'vitest';
import { buildBlockPrompt, buildSectionPrompt, parseBlockRating, parseSections } from '../src/shared/goal-prompt';

describe('block ratings from the model', () => {
  it('accepts and clamps a valid rating', () => {
    expect(parseBlockRating('{"topic":"Training setup","relevance":12,"attention":-3,"reason":"explains training"}')).toEqual({
      topic: 'Training setup',
      relevance: 10,
      attention: 0,
      reason: 'explains training',
    });
  });

  it('rounds fractional scores and tolerates numeric strings', () => {
    expect(parseBlockRating('{"topic":"x","relevance":"6.6","attention":2.4,"reason":"y"}')).toMatchObject({ relevance: 7, attention: 2 });
  });

  it('rejects malformed or incomplete output', () => {
    expect(() => parseBlockRating('not json')).toThrow();
    expect(() => parseBlockRating('{"topic":"x","attention":3}')).toThrow(/missing score/);
    expect(() => parseBlockRating('{"topic":"x","relevance":"high","attention":3}')).toThrow(/missing score/);
  });

  it('keeps the goal and excerpt bounded in the prompt', () => {
    const p = buildBlockPrompt('g'.repeat(1000), 'w '.repeat(5000), 'Title');
    expect(p.length).toBeLessThan(3200);
    expect(p).toContain('Video title: Title');
  });
});

describe('section grouping from the model', () => {
  it('accepts a contiguous partition of the parts', () => {
    const raw = '{"sections":[{"from":3,"to":4,"topic":"Intro"},{"from":5,"to":7,"topic":"Training"}]}';
    expect(parseSections(raw, 3, 7)).toEqual([
      { from: 3, to: 4, topic: 'Intro' },
      { from: 5, to: 7, topic: 'Training' },
    ]);
  });

  it('rejects gaps, overlaps, out-of-range or incomplete coverage', () => {
    expect(parseSections('{"sections":[{"from":0,"to":1,"topic":"a"},{"from":3,"to":4,"topic":"b"}]}', 0, 4)).toBeNull(); // gap
    expect(parseSections('{"sections":[{"from":0,"to":2,"topic":"a"},{"from":2,"to":4,"topic":"b"}]}', 0, 4)).toBeNull(); // overlap
    expect(parseSections('{"sections":[{"from":0,"to":9,"topic":"a"}]}', 0, 4)).toBeNull(); // beyond the parts
    expect(parseSections('{"sections":[{"from":0,"to":2,"topic":"a"}]}', 0, 4)).toBeNull(); // missing the end
    expect(parseSections('{"sections":[]}', 0, 4)).toBeNull();
    expect(parseSections('garbage', 0, 4)).toBeNull();
  });

  it('lists numbered parts in the prompt', () => {
    expect(buildSectionPrompt('goal', [{ index: 3, topic: 'Intro' }, { index: 4, topic: 'Data' }])).toContain('3: Intro\n4: Data');
  });
});
