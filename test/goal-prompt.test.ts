import { describe, expect, it } from 'vitest';
import {
  BLOCK_SCHEMA,
  BLOCK_SYSTEM_PROMPT,
  BLOCK_SYSTEM_PROMPT_WITH_NEEDS,
  BREAKDOWN_SCHEMA,
  BREAKDOWN_SYSTEM_PROMPT,
  MAX_NEED_CHARS,
  buildBlockPrompt,
  buildBreakdownPrompt,
  buildSectionPrompt,
  parseBlockRating,
  parseBreakdown,
  parseSections,
} from '../src/shared/goal-prompt';

describe('goal breakdown from the model (POC 1.5)', () => {
  const raw = (needs: unknown) => JSON.stringify({ needs });

  it('accepts 3 to 6 needs, trimmed and de-duplicated', () => {
    expect(parseBreakdown(raw(['  generating an SSH key ', 'adding the key', 'Adding the key', 'testing the connection']))).toEqual([
      'generating an SSH key',
      'adding the key',
      'testing the connection',
    ]);
  });

  it('bounds the number and length of needs', () => {
    expect(parseBreakdown(raw(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']))).toHaveLength(6);
    expect(parseBreakdown(raw(['x'.repeat(500), 'b', 'c']))[0]).toHaveLength(MAX_NEED_CHARS);
    expect(BREAKDOWN_SCHEMA.properties.needs).toMatchObject({ minItems: 3, maxItems: 6, items: { maxLength: MAX_NEED_CHARS } });
  });

  it('rejects unusable output (Goal Mode then scores without a breakdown)', () => {
    expect(() => parseBreakdown(raw(['a', 'a', ' ']))).toThrow(/too few needs/);
    expect(() => parseBreakdown(raw([1, 2, 3]))).toThrow(/too few needs/);
    expect(() => parseBreakdown('{"items":["a","b","c"]}')).toThrow(/no needs/);
    expect(() => parseBreakdown('not json')).toThrow();
  });

  it('sees only the goal, never the video', () => {
    expect(buildBreakdownPrompt('  Learn SSH  ')).toBe("Viewer's goal: Learn SSH");
    expect(buildBreakdownPrompt('g'.repeat(1000)).length).toBeLessThan(400);
    expect(BREAKDOWN_SYSTEM_PROMPT).toContain('not the video');
    expect(BREAKDOWN_SYSTEM_PROMPT).toContain('Do not guess the video');
  });
});

describe('block ratings from the model', () => {
  it('accepts and clamps a valid rating', () => {
    expect(parseBlockRating('{"topic":"Training setup","relevance":12,"attention":-3,"reason":"explains training"}')).toEqual({
      topic: 'Training setup',
      relevance: 10,
      attention: 0,
      reason: 'explains training',
    });
  });

  it('keeps the POC 1.1 rubric and output fields', () => {
    expect(BLOCK_SYSTEM_PROMPT).toContain(
      '- relevance (0-10): how much it helps the viewer\'s goal. 0 = unrelated (intro, sponsor, small talk, off-topic); 5 = useful background; 10 = directly answers the goal.',
    );
    expect(BLOCK_SYSTEM_PROMPT).toContain('- attention (0-10): how much careful listening it needs.');
    expect(BLOCK_SCHEMA.properties.relevance).toEqual({ type: 'integer', minimum: 0, maximum: 10 });
    expect(Object.keys(BLOCK_SCHEMA.properties)).toEqual(['topic', 'relevance', 'attention', 'reason']);
  });

  it('with a breakdown, only says the needs come with the goal; the rubric is identical', () => {
    expect(BLOCK_SYSTEM_PROMPT_WITH_NEEDS).not.toBe(BLOCK_SYSTEM_PROMPT);
    expect(BLOCK_SYSTEM_PROMPT_WITH_NEEDS).toContain('the information it needs (worked out from the goal alone, not from the video)');
    const rubric = (p: string) => p.slice(p.indexOf('Rate the excerpt:'));
    expect(rubric(BLOCK_SYSTEM_PROMPT_WITH_NEEDS)).toBe(rubric(BLOCK_SYSTEM_PROMPT));
  });

  it('lists the needs before the excerpt, and is the POC 1.1 prompt without them', () => {
    const plain = buildBlockPrompt('goal', 'text', 'T');
    expect(buildBlockPrompt('goal', 'text', 'T', null)).toBe(plain);
    expect(buildBlockPrompt('goal', 'text', 'T', [])).toBe(plain);
    const p = buildBlockPrompt('goal', 'text', 'T', ['generating an SSH key', 'adding the key to GitHub']);
    expect(p).toContain('What the viewer needs to learn for this goal:\n- generating an SSH key\n- adding the key to GitHub');
    expect(p.indexOf('needs to learn')).toBeGreaterThan(p.indexOf('Video title'));
    expect(p.indexOf('needs to learn')).toBeLessThan(p.indexOf('Excerpt:'));
    expect(buildBlockPrompt('goal', 'text', 'T', Array(20).fill('n'.repeat(500))).length).toBeLessThan(plain.length + 8 * (MAX_NEED_CHARS + 6));
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
