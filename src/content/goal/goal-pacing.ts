/**
 * Goal Mode: deterministic relevance/attention → pacing. The model never chooses a speed; this
 * table does. Each category is a position within the user's pace range (Relaxed/Normal/Fast),
 * so the user's pace preference still applies. Edit GOAL_PACING to tune after testing.
 */
import type { Profile } from '../controller';
import type { PacingBlock } from './goal-map';

export interface PacingCategory {
  /** Matches when relevance >= minRelevance and attention >= minAttention (first match wins). */
  minRelevance: number;
  minAttention: number;
  /** Position in the pace's range: 0 = its slowest (min rate), 1 = its fastest (max rate). */
  position: number;
  label: string;
}

/** Checked top to bottom; the last entry catches everything. */
export const GOAL_PACING: PacingCategory[] = [
  { minRelevance: 7, minAttention: 7, position: 0, label: 'Key part for your goal' },
  { minRelevance: 7, minAttention: 0, position: 0.15, label: 'Important for your goal' },
  { minRelevance: 5, minAttention: 0, position: 0.4, label: 'Relevant background' },
  { minRelevance: 3, minAttention: 0, position: 0.75, label: 'Less relevant to your goal' },
  { minRelevance: 0, minAttention: 0, position: 1, label: 'Not relevant to your goal' },
];

export interface GoalTarget {
  rate: number;
  label: string;
}

/** Pacing comes from a single block's own scores (never from a merged section). */
export function goalTarget(block: Pick<PacingBlock, 'relevance' | 'attention'>, pace: Profile, table = GOAL_PACING): GoalTarget {
  const c = table.find((x) => block.relevance >= x.minRelevance && block.attention >= x.minAttention) ?? table[table.length - 1]!;
  return { rate: pace.minRate + c.position * (pace.maxRate - pace.minRate), label: c.label };
}
