/**
 * Goal Mode: split a transcript into analysis blocks at natural boundaries (the longest pause in a
 * window), so each Prompt API request stays small and blocks follow the speech, not a fixed grid.
 */
import type { TimedWord } from '../../shared/types';

export interface Block {
  index: number;
  start: number; // seconds
  end: number; // seconds (exclusive); equals the next block's start
  text: string;
}

export const BLOCKS = {
  /** A block may end once it is this long… */
  minSec: 45,
  /** …aims to end around here… */
  targetSec: 75,
  /** …and must end by here, or at this many words, whichever comes first. */
  maxSec: 100,
  maxWords: 300,
};

/**
 * Blocks covering [0, transcriptEnd) without gaps or overlaps. Each cut is placed at the longest
 * gap between words inside the allowed window, i.e. at a pause rather than mid-sentence.
 */
export function makeBlocks(words: TimedWord[], transcriptEnd: number, opts = BLOCKS): Block[] {
  if (words.length === 0) return [];
  const blocks: Block[] = [];
  let first = 0; // index of the first word of the current block
  let start = 0;
  while (first < words.length) {
    // Find the last word that may still belong to this block.
    let last = first;
    while (
      last + 1 < words.length &&
      words[last + 1]!.t - start < opts.maxSec &&
      last + 1 - first < opts.maxWords
    ) {
      last++;
    }
    let cut = words.length; // index of the first word of the next block
    if (last + 1 < words.length) {
      // Choose the longest pause between words whose time falls in [minSec, maxSec], preferring
      // cuts near the target length when pauses are equal.
      let best = last + 1;
      let bestScore = -Infinity;
      for (let i = first + 1; i <= last + 1; i++) {
        const t = words[i]!.t;
        if (t - start < opts.minSec && i <= last) continue;
        const gap = t - words[i - 1]!.t;
        const score = gap - Math.abs(t - start - opts.targetSec) / 1000;
        if (score > bestScore) {
          bestScore = score;
          best = i;
        }
      }
      cut = best;
    }
    const end = cut < words.length ? words[cut]!.t : Math.max(transcriptEnd, words[words.length - 1]!.t);
    blocks.push({
      index: blocks.length,
      start,
      end,
      text: words
        .slice(first, cut)
        .map((w) => w.w)
        .join(' '),
    });
    first = cut;
    start = end;
  }
  return blocks;
}
