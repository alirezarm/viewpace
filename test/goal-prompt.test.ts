import { describe, expect, it } from 'vitest';
import { BLOCK_SCHEMA, BLOCK_SYSTEM_PROMPT, RELEVANCE_CATEGORIES, RELEVANCE_VALUE, buildBlockPrompt, buildSectionPrompt, parseBlockRating, parseSections } from '../src/shared/goal-prompt';

describe('block ratings from the model', () => {
  const raw = (relevance: unknown, attention: unknown = 4) => JSON.stringify({ topic: 'Training setup', relevance, attention, reason: 'explains training' });

  it('accepts each relevance category and keeps what the model chose', () => {
    for (const c of RELEVANCE_CATEGORIES) {
      expect(parseBlockRating(raw(c))).toEqual({ topic: 'Training setup', relevance: RELEVANCE_VALUE[c], attention: 4, reason: 'explains training', relevanceCategory: c });
    }
  });

  it('maps categories to fixed numeric relevance', () => {
    expect(RELEVANCE_VALUE).toEqual({ irrelevant: 2, background: 3, useful: 5, important: 7, essential: 10 });
  });

  it('tolerates case and surrounding whitespace in the category', () => {
    expect(parseBlockRating(raw('  Important ')).relevanceCategory).toBe('important');
  });

  it('still clamps and rounds attention', () => {
    expect(parseBlockRating(raw('useful', -3)).attention).toBe(0);
    expect(parseBlockRating(raw('useful', '6.6')).attention).toBe(7);
  });

  it('rejects unknown, numeric or missing relevance, and malformed output', () => {
    expect(() => parseBlockRating(raw('very relevant'))).toThrow(/unknown relevance category/);
    expect(() => parseBlockRating(raw(8))).toThrow(/unknown relevance category/);
    expect(() => parseBlockRating(raw(null))).toThrow(/unknown relevance category/);
    expect(() => parseBlockRating('{"topic":"x","attention":3}')).toThrow(/unknown relevance category/);
    expect(() => parseBlockRating(raw('useful', 'lots'))).toThrow(/missing score/);
    expect(() => parseBlockRating('not json')).toThrow();
  });

  it('asks the model for a category, not a 0-10 relevance score', () => {
    expect(BLOCK_SCHEMA.properties.relevance).toEqual({ type: 'string', enum: RELEVANCE_CATEGORIES });
    expect(Object.keys(BLOCK_SCHEMA.properties)).toEqual(['topic', 'relevance', 'attention', 'reason']); // order unchanged
    for (const c of RELEVANCE_CATEGORIES) expect(BLOCK_SYSTEM_PROMPT).toContain(`${c} = `);
    expect(BLOCK_SYSTEM_PROMPT).not.toMatch(/relevance \(0-10\)/);
    expect(BLOCK_SYSTEM_PROMPT).toContain('attention (0-10)');
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
