/** Plain-language explanations for the user-facing badge. Describes decisions; never makes them. */

export interface ChangeContext {
  previousRate: number;
  rate: number;
  mode: 'baseline' | 'ai';
  /** AI score and the video's reference, both 0..10; null when not used for this decision. */
  aiScore: number | null;
  aiMean: number | null;
  pauseRatio: number | null;
  /** Too few words to measure (music, silence). */
  littleSpeech: boolean;
}

export function describeChange(c: ChangeContext): string {
  const up = c.rate > c.previousRate;
  if (c.littleSpeech) return up ? 'Speeding up: no one is talking' : 'Easing back: no one is talking';
  const aiDiff = c.mode === 'ai' && c.aiScore !== null && c.aiMean !== null ? c.aiScore - c.aiMean : 0;
  if (up) {
    if (aiDiff <= -1) return 'Speeding up through an easier part';
    if ((c.pauseRatio ?? 0) >= 0.2) return 'Speeding up through pauses';
    return 'Speeding up for a slow speaker';
  }
  if (aiDiff >= 1) return 'Slowing down for a harder part';
  return 'Slowing down for a fast speaker';
}
