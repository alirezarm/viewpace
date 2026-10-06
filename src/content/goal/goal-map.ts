/**
 * Goal Mode: the video map. Holds the model's ratings per block and the (optional) validated
 * section grouping, and answers "which region contains time t?". Only analysed blocks produce
 * regions: unanalysed or failed parts stay unmapped, never invented.
 */
import type { BlockRating, SectionRange } from '../../shared/goal-prompt';
import type { Block } from './blocks';

export interface GoalRegion {
  start: number;
  end: number;
  topic: string;
  relevance: number; // 0..10
  attention: number; // 0..10
  reason: string;
}

/** Blocks are grouped into sections per window of this many blocks (bounds the pass-2 prompt). */
export const SECTION_WINDOW = 40;

export class GoalMap {
  private ratings = new Map<number, BlockRating>();
  private failed = new Set<number>();
  /** Validated sections per window index. */
  private sections = new Map<number, SectionRange[]>();
  private cache: GoalRegion[] | null = null;

  constructor(readonly blocks: Block[]) {}

  setRating(index: number, r: BlockRating): void {
    this.ratings.set(index, r);
    this.failed.delete(index);
    this.cache = null;
  }

  setFailed(index: number): void {
    if (!this.ratings.has(index)) this.failed.add(index);
    this.cache = null;
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
    this.sections.set(w, sections);
    this.cache = null;
  }

  get rated(): number {
    return this.ratings.size;
  }

  get failedCount(): number {
    return this.failed.size;
  }

  /**
   * Non-overlapping regions in time order. A window with validated sections (and all its blocks
   * rated) is merged into one region per section: relevance = the highest of its blocks (goal
   * content is never sped through), attention = the rounded average. Otherwise each rated block
   * is its own region.
   */
  regions(): GoalRegion[] {
    if (this.cache) return this.cache;
    const out: GoalRegion[] = [];
    for (let w = 0; w < this.windowCount; w++) {
      const [first, last] = this.windowRange(w);
      const sections = this.sections.get(w);
      if (sections && this.windowRated(w)) {
        for (const s of sections) {
          const members = [];
          for (let i = s.from; i <= s.to; i++) members.push(this.ratings.get(i)!);
          const top = members.reduce((a, b) => (b.relevance > a.relevance ? b : a));
          out.push({
            start: this.blocks[s.from]!.start,
            end: this.blocks[s.to]!.end,
            topic: s.topic || top.topic,
            relevance: top.relevance,
            attention: Math.round(members.reduce((n, m) => n + m.attention, 0) / members.length),
            reason: top.reason,
          });
        }
      } else {
        for (let i = first; i <= last; i++) {
          const r = this.ratings.get(i);
          if (!r) continue;
          const b = this.blocks[i]!;
          out.push({ start: b.start, end: b.end, topic: r.topic, relevance: r.relevance, attention: r.attention, reason: r.reason });
        }
      }
    }
    this.cache = out;
    return out;
  }

  /** The region containing time `t`, or null if that part is not mapped (yet). */
  regionAt(t: number): GoalRegion | null {
    const rs = this.regions();
    let lo = 0;
    let hi = rs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const r = rs[mid]!;
      if (t < r.start) hi = mid - 1;
      else if (t >= r.end) lo = mid + 1;
      else return r;
    }
    return null;
  }

  /** Index of the block containing time `t` (for ordering the analysis upcoming-first). */
  blockAt(t: number): number {
    const i = this.blocks.findIndex((b) => t >= b.start && t < b.end);
    return i === -1 ? (t <= 0 ? 0 : this.blocks.length - 1) : i;
  }
}
