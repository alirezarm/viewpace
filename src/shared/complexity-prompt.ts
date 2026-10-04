/** Prompt + output contract for the semantic complexity provider. Model-agnostic. */

export const MAX_CHUNK_CHARS = 1500;

export const SYSTEM_PROMPT = `You rate how much careful listening a short excerpt of a spoken video transcript requires.
The excerpt is auto-transcribed speech: it may lack punctuation and contain transcription errors.

Score "complexity" as an integer from 0 to 10:
0-2: filler, greetings, small talk, sponsor reads, repetition, jokes, recaps of what was already said.
3-4: casual narrative or simple explanation; easy to follow at high speed.
5-6: ordinary informational content with some new ideas.
7-8: dense explanation: new technical terms, multi-step reasoning, definitions, comparisons.
9-10: very dense: formulas, numbers or code read aloud, precise instructions, tightly packed new concepts.

Judge only information density and difficulty of the content, not how fast it is spoken.
Give a reason of at most 8 words.`;

/** JSON Schema passed as responseConstraint. */
export const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    complexity: { type: 'integer', minimum: 0, maximum: 10 },
    reason: { type: 'string', maxLength: 80 },
  },
  required: ['complexity', 'reason'],
  additionalProperties: false,
} as const;

export function buildUserPrompt(chunk: string): string {
  const text = chunk.length > MAX_CHUNK_CHARS ? chunk.slice(0, MAX_CHUNK_CHARS) + ' …' : chunk;
  return `Transcript excerpt:\n"""\n${text}\n"""`;
}

/** Validate and clamp the model output. Throws on anything unusable. */
export function parseComplexity(raw: string): { raw: number; score: number; label: string } {
  const obj = JSON.parse(raw) as { complexity?: unknown; reason?: unknown };
  const n = typeof obj.complexity === 'number' ? obj.complexity : Number(obj.complexity);
  if (!Number.isFinite(n)) throw new Error(`invalid complexity: ${raw.slice(0, 100)}`);
  const clamped = Math.min(10, Math.max(0, Math.round(n)));
  const label = typeof obj.reason === 'string' ? obj.reason.slice(0, 80) : '';
  return { raw: clamped, score: clamped / 10, label };
}
