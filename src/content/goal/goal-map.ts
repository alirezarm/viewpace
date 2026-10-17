/**
 * Goal Mode: the video map, at two deliberately separate levels.
 *
 *  - Blocks (pass 1): each rated block has relevance/attention for the user's goal. These block
 *    scores are the ONLY input to playback pacing (`pacingBlockAt`).
 *  - Sections (pass 2): validated groupings of consecutive blocks with a topic label. They are for
 *    structure, labels and display only and intentionally carry no scores, so they cannot be used
 *    for pacing (one relevant block must not make a whole long section slow).
 *
 * Only analysed blocks are mapped: unanalysed or failed parts stay unmapped, never invented.
 */
import type { BlockRating, SectionRange } from '../../shared/goal-prompt';
import type { Block } from './blocks';

/** A rated block: the authoritative signal for playback pacing. */
export interface PacingBlock {
  index: number;
  start: number;
  end: number;
  topic: string;
  relevance: number; // 0..10
  attention: number; // 0..10
  reason: string;
}

/** A pass-2 section: labels/structure only. Has no relevance/attention by design; never pace from it. */
export interface DisplaySection {
  start: number;
  end: number;
  topic: string;
  firstBlock: number;
  lastBlock: number;
}

/** One row of the map outline for display: a section heading or a block (rated or not). */
export type OutlineEntry =
  | { kind: 'section'; section: DisplaySection }
  | { kind: 'block'; start: number; end: number; index: number; block: PacingBlock | null; failed: boolean };

/** Blocks are grouped into sections per window of this many blocks (bounds the pass-2 prompt). */
export const SECTION_WINDOW = 40;

export class GoalMap {
  private ratings = new Map<number, BlockRating>();
  private failed = new Set<number>();
  /** Validated sections per window index. */
  private validSections = new Map<number, SectionRange[]>();

  constructor(readonly blocks: Block[]) {}

  setRating(index: number, r: BlockRating): void {
    this.ratings.set(index, r);
    this.failed.delete(index);
  }

  setFailed(index: number): void {
    if (!this.ratings.has(index)) this.failed.add(index);
  }

  rating(index: number): BlockRating | undefined {
    return this.ratings.get(index);
  }

  /** Window [first, last] block indices for window `w`. */
  windowRange(w: number): [number, number] {
    const first = w * SECTION_WINDOW;
    return [first, Math.min(this.blocks.length - 1, first + SECTION_WINDOW - 1)];
  }

  get windowCount(): number {
    return Math.ceil(this.blocks.length / SECTION_WINDOW);
  }

  /** True once every block of window `w` has a rating (sections can then be requested). */
  windowRated(w: number): boolean {
    const [first, last] = this.windowRange(w);
    for (let i = first; i <= last; i++) if (!this.ratings.has(i)) return false;
    return true;
  }

  setSections(w: number, sections: SectionRange[]): void {
    this.validSections.set(w, sections);
  }

  get rated(): number {
    return this.ratings.size;
  }

  get failedCount(): number {
    return this.failed.size;
  }

  /** Blocks already attempted (rated, or failed after its retry): never rated again. */
  done(index: number): boolean {
    return this.ratings.has(index) || this.failed.has(index);
  }

  /**
   * SCHEDULING: the next block to rate for a viewer at time `t`: the first block not yet attempted
   * at or after the one containing `t`, wrapping round to the start. Null once every block is done.
   */
  nextToRate(t: number): number | null {
    const n = this.blocks.length;
    const k = this.blockAt(t);
    for (let i = 0; i < n; i++) {
      const j = (k + i) % n;
      if (!this.done(j)) return j;
    }
    return null;
  }

  /** Index of the block containing time `t` (clamped to the first/last block). */
  blockAt(t: number): number {
    let lo = 0;
    let hi = this.blocks.length - 1;
    if (hi < 0) return 0;
    if (t < this.blocks[0]!.start) return 0;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (this.blocks[mid]!.start <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  private pacingBlock(i: number): PacingBlock | null {
    const r = this.ratings.get(i);
    const b = this.blocks[i];
    if (!r || !b) return null;
    return { index: i, start: b.start, end: b.end, topic: r.topic, relevance: r.relevance, attention: r.attention, reason: r.reason };
  }

  /** PACING: the rated block containing time `t`, or null if that part isn't mapped (yet). */
  pacingBlockAt(t: number): PacingBlock | null {
    if (this.blocks.length === 0) return null;
    const i = this.blockAt(t);
    const b = this.blocks[i]!;
    if (t < b.start || t >= b.end) return null; // outside the transcript
    return this.pacingBlock(i);
  }

  /** DISPLAY: validated sections, in time order (only for windows whose blocks are all rated). */
  sections(): DisplaySection[] {
    const out: DisplaySection[] = [];
    for (let w = 0; w < this.windowCount; w++) {
      const ranges = this.validSections.get(w);
      if (!ranges || !this.windowRated(w)) continue;
      for (const s of ranges) {
        out.push({ start: this.blocks[s.from]!.start, end: this.blocks[s.to]!.end, topic: s.topic, firstBlock: s.from, lastBlock: s.to });
      }
    }
    return out;
  }

  /** DISPLAY: the section containing time `t`, if sections are available there. */
  sectionAt(t: number): DisplaySection | null {
    return this.sections().find((s) => t >= s.start && t < s.end) ?? null;
  }

  /**
   * DISPLAY: every block in time order (rated, failed or not yet analysed), preceded by a heading
   * for each validated section it starts.
   */
  outline(): OutlineEntry[] {
    const starts = new Map(this.sections().map((s) => [s.firstBlock, s]));
    const out: OutlineEntry[] = [];
    for (const b of this.blocks) {
      const section = starts.get(b.index);
      if (section) out.push({ kind: 'section', section });
      out.push({ kind: 'block', start: b.start, end: b.end, index: b.index, block: this.pacingBlock(b.index), failed: this.failed.has(b.index) });
    }
    return out;
  }
}
