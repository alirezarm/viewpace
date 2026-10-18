import { describe, expect, it } from 'vitest';
import {
  BLOCK_SCHEMA,
  BLOCK_SYSTEM_PROMPT,
  BLOCK_SYSTEM_PROMPT_WITH_NEEDS,
  BREAKDOWN_SCHEMA,
  BREAKDOWN_SYSTEM_PROMPT,
  MAX_NEED_CHARS,
  blockSystemPrompt,
  buildBlockPrompt,
  buildBreakdownPrompt,
  buildSectionPrompt,
  parseBlockRating,
  parseBreakdown,
  parseRegionLabels,
  parseSections,
  buildRegionPrompt,
  regionSchema,
  MAX_LABEL_REGIONS,
  representativeTopics,
} from '../src/shared/goal-prompt';

describe('topics representing a whole region', () => {
  const early = ['LLM as operating system kernel', 'LLM context window as working memory', 'LLMs as an operating system ecosystem'];
  const security = [
    'Jailbreak attacks and LLM safety',
    'Jailbreak attacks on language models',
    'LLM training: jailbreaking and encoding',
    'LLM jailbreaking with adversarial examples',
    'Prompt injection attack example',
    'Prompt injection attacks and LLM vulnerabilities',
    'Prompt injection attack on LLMs',
    'Prompt injection and data exfiltration risks',
    'Data poisoning attacks on LLMs',
    'LLM vulnerabilities: prompt injection attacks',
    'LLM security and evolving attack defenses',
  ];

  it('keeps every topic of a short region, in order', () => {
    expect(representativeTopics(['a b c', 'd e f', 'a b c'])).toEqual(['a b c', 'd e f']);
  });

  it('is not biased to the first topics: the dominant theme fills most of the sample', () => {
    const picked = representativeTopics([...early, ...security]);
    expect(picked).toHaveLength(8);
    expect(picked.filter((t) => early.includes(t)).length).toBeLessThanOrEqual(2);
    expect(picked.filter((t) => /jailbreak|injection|poisoning|security|attack/i.test(t)).length).toBeGreaterThanOrEqual(6);
  });

  it('covers the start, middle and end of the region, in time order', () => {
    const all = [...early, ...security];
    const picked = representativeTopics(all);
    expect(picked[0]).toBe(all[0]);
    expect(picked[picked.length - 1]).toBe(all[all.length - 1]);
    const idx = picked.map((t) => all.indexOf(t));
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });

  it('counts repeated topics as the theme they are', () => {
    const asides = ['Speaker biography', 'Conference logistics', 'Audience question', 'Slide deck typo', 'Coffee break', 'Book recommendation', 'Weather remark', 'Camera setup', 'Sponsor thanks', 'Microphone check', 'Hiring announcement', 'Closing joke'];
    const repeats = ['Intro', 'Prompt injection demo', 'Prompt injection demo', 'Prompt injection demo', ...asides];
    expect(representativeTopics(repeats)).toContain('Prompt injection demo');
  });
});

describe('region names from the model', () => {
  const ids = ['1', '2', '3'];
  const raw = (labels: unknown) => JSON.stringify({ labels });

  it('attaches short labels by id', () => {
    expect(parseRegionLabels(raw([{ id: '1', label: 'LLM basics' }, { id: '3', label: '  Fine-tuning &  RLHF. ' }]), ids)).toEqual({
      '1': 'LLM basics',
      '3': 'Fine-tuning & RLHF',
    });
  });

  it('drops unknown ids, duplicates, empty or sentence-like labels; never throws', () => {
    const labels = [
      { id: '9', label: 'Not asked for' },
      { id: '1', label: 'Pretraining' },
      { id: '1', label: 'Second answer' },
      { id: '2', label: '   ' },
      { id: '3', label: 'This part explains how the model is trained in great detail' },
    ];
    expect(parseRegionLabels(raw(labels), ids)).toEqual({ '1': 'Pretraining' });
    expect(parseRegionLabels('not json', ids)).toEqual({});
    expect(parseRegionLabels('{"labels":"nope"}', ids)).toEqual({});
    expect(parseRegionLabels(raw([{ id: 1, label: 'x' }]), ids)).toEqual({});
  });

  it('asks for exactly the ids sent, from the goal and block topics only (no transcript)', () => {
    expect(regionSchema(ids).properties.labels.items.properties.id.enum).toEqual(ids);
    const p = buildRegionPrompt('Understand how LLMs are trained', [
      { id: '1', topics: ['LLM definition and Llama 2 model', 'Llama 2 weights'], blocks: 2 },
      { id: '2', topics: ['Next-word prediction'], blocks: 1 },
    ]);
    expect(p).toBe("Viewer's goal: Understand how LLMs are trained\n\nParts:\nPart 1 (2 pieces):\n- LLM definition and Llama 2 model\n- Llama 2 weights\n\nPart 2 (1 piece):\n- Next-word prediction");
  });

  it('stays bounded however many regions or topics come in', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ id: String(i + 1), topics: Array(20).fill('t'.repeat(300)), blocks: 20 }));
    const p = buildRegionPrompt('g', many);
    expect(p.match(/^Part /gm)).toHaveLength(MAX_LABEL_REGIONS);
    expect(p.length).toBeLessThan(MAX_LABEL_REGIONS * 8 * 90 + 2000);
  });
});

describe('goal breakdown from the model', () => {
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

  it('rejects unusable output (blocks are then rated without a breakdown)', () => {
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

  it('rates relevance and attention on 0-10 with the fixed rubric and output fields', () => {
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

  it('picks the system prompt by whether there is a breakdown', () => {
    expect(blockSystemPrompt(['a', 'b', 'c'])).toBe(BLOCK_SYSTEM_PROMPT_WITH_NEEDS);
    expect(blockSystemPrompt(null)).toBe(BLOCK_SYSTEM_PROMPT);
    expect(blockSystemPrompt(undefined)).toBe(BLOCK_SYSTEM_PROMPT);
    expect(blockSystemPrompt([])).toBe(BLOCK_SYSTEM_PROMPT);
  });

  it('lists the needs before the excerpt, and leaves them out entirely without a breakdown', () => {
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
