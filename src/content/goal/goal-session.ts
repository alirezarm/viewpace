/**
 * Goal Mode (experimental): per-video state, the analysis job, and the per-tick decision.
 *
 * Analysis: the goal is broken into a few information needs once, then every transcript block is
 * rated on its own against the goal and those same needs (no block's rating depends on another's,
 * so blocks can be rated in any order). Pacing is a deterministic mapping of each block's rating.
 *
 * Everything lives in memory for the current video only and is discarded on video change.
 * "No data, no change": without a mapped region, Goal Mode never moves the speed.
 */
import type { BlockRating, PartSummary, SectionRange } from '../../shared/goal-prompt';
import type { TimedWord } from '../../shared/types';
import type { Profile } from '../controller';
import { makeBlocks, type Block } from './blocks';
import { GoalMap, type DisplaySection, type PacingBlock } from './goal-map';
import { goalTarget } from './goal-pacing';

/** On-device analysis used by Goal Mode (Gemini Nano in production, a fake in tests). */
export interface GoalAnalyzer {
  available(): Promise<boolean>;
  /** The goal's information needs, worked out from the goal alone (never the video). Throws if unusable. */
  breakdownGoal(goal: string): Promise<string[]>;
  /** Rate one block against the goal and its breakdown (`needs`; null = none). Throws if unusable. */
  rateBlock(goal: string, text: string, title?: string, needs?: string[] | null): Promise<BlockRating>;
  /** Validated sections covering exactly first..last, or null (keep block-level regions). */
  groupSections(goal: string, parts: PartSummary[], first: number, last: number): Promise<SectionRange[] | null>;
}

export type GoalPhase = 'no-transcript' | 'no-ai' | 'mapping' | 'ready' | 'failed' | 'stopped';

export interface GoalStatus {
  phase: GoalPhase;
  goal: string;
  rated: number;
  total: number;
  failed: number;
  /** Share of blocks attempted so far (rated or failed), 0..1. */
  progress: number;
  message: string;
}

export const MAX_GOAL_LENGTH = 300;

export class GoalSession {
  readonly map: GoalMap;
  phase: GoalPhase = 'mapping';
  /** The goal's breakdown, given unchanged to every block; null if it couldn't be made (blocks are rated from the goal alone). */
  needs: string[] | null = null;
  /** False until the breakdown call has finished (succeeded or not) and block rating can start. */
  breakdownDone = false;
  private cancelled = false;

  constructor(
    readonly videoId: string,
    readonly goal: string,
    blocks: Block[],
  ) {
    this.map = new GoalMap(blocks);
  }

  cancel(): void {
    this.cancelled = true;
    if (this.phase === 'mapping') this.phase = 'stopped';
  }

  /**
   * Break the goal down (one call, goal only; if it fails, blocks are rated without a breakdown).
   * Then rate every block once (one retry each), always picking the next unrated block at or after
   * the viewer's current position (`playhead`, read before each block), so a seek redirects the
   * work there. Each rating is usable by playback as soon as it lands. Section labels are grouped
   * last, so they never delay a block. Stops as soon as the session is cancelled or the user is no
   * longer on this video; results land only in this session's own map.
   */
  async run(analyzer: GoalAnalyzer, ctx: { isCurrent: () => boolean; playhead: () => number; title?: string }): Promise<void> {
    const live = () => !this.cancelled && ctx.isCurrent();

    try {
      this.needs = await analyzer.breakdownGoal(this.goal);
    } catch {
      this.needs = null;
    }
    if (!live()) return; // stopped or navigated away while the breakdown ran
    this.breakdownDone = true;

    for (let i = this.map.nextToRate(ctx.playhead()); i !== null; i = this.map.nextToRate(ctx.playhead())) {
      if (!live()) return;
      const block = this.map.blocks[i]!;
      let rating: BlockRating | null = null;
      for (let attempt = 0; attempt < 2 && !rating && live(); attempt++) {
        try {
          rating = await analyzer.rateBlock(this.goal, block.text, ctx.title, this.needs);
        } catch {
          rating = null;
        }
      }
      if (!live()) return; // a result that arrives after navigating away is discarded
      if (rating) this.map.setRating(i, rating);
      else this.map.setFailed(i);
    }
    if (!live()) return;
    // The map is complete: Goal Mode is ready even before any section labels exist.
    this.phase = this.map.rated > 0 ? 'ready' : 'failed';

    // Labels only: every window whose blocks are all rated (a window with a failed block keeps
    // block-level regions).
    for (let w = 0; w < this.map.windowCount; w++) {
      if (!live()) return;
      if (this.map.windowRated(w)) {
        const [first, last] = this.map.windowRange(w);
        const parts: PartSummary[] = [];
        for (let j = first; j <= last; j++) parts.push({ index: j, topic: this.map.rating(j)!.topic });
        let sections: SectionRange[] | null = null;
        try {
          sections = await analyzer.groupSections(this.goal, parts, first, last);
        } catch {
          sections = null; // keep block-level regions
        }
        if (!live()) return;
        if (sections) this.map.setSections(w, sections);
      }
    }
  }
}

/** What Goal Mode wants this tick. */
export type GoalDecision =
  | { kind: 'off' } // Goal Mode not active for this video: normal ViewPace behaviour
  | { kind: 'hold'; note: string } // active, but no decision: leave the speed alone
  /** `block` drives the speed; `section` is only its label (may be null before grouping). */
  | { kind: 'target'; rate: number; label: string; block: PacingBlock; section: DisplaySection | null };

export class GoalController {
  session: GoalSession | null = null;
  /** Shown once after a failed start (e.g. no transcript), until the video changes. */
  private notice: { videoId: string; phase: GoalPhase; goal: string } | null = null;

  /**
   * Start Goal Mode for the current video. Validates up front and never analyses silently:
   * this only happens on the user's explicit Start.
   */
  async start(opts: {
    videoId: string;
    goal: string;
    words: TimedWord[] | null; // full caption track, or null if not available
    transcriptEnd: number;
    analyzer: GoalAnalyzer;
    isCurrent: () => boolean;
    /** The viewer's current position; read before each block, so analysis follows seeks. */
    playhead: () => number;
    title?: string;
  }): Promise<GoalStatus | null> {
    this.stop();
    const goal = opts.goal.trim().slice(0, MAX_GOAL_LENGTH);
    if (!opts.words || opts.words.length === 0) {
      this.notice = { videoId: opts.videoId, phase: 'no-transcript', goal };
      return this.status(opts.videoId);
    }
    if (!(await opts.analyzer.available())) {
      this.notice = { videoId: opts.videoId, phase: 'no-ai', goal };
      return this.status(opts.videoId);
    }
    if (!opts.isCurrent()) return this.status(opts.videoId);
    const session = new GoalSession(opts.videoId, goal, makeBlocks(opts.words, opts.transcriptEnd));
    this.session = session;
    void session
      .run(opts.analyzer, { isCurrent: opts.isCurrent, playhead: opts.playhead, title: opts.title })
      .catch(() => {
        if (this.session === session && session.phase === 'mapping') session.phase = 'failed';
      });
    return this.status(opts.videoId);
  }

  stop(): void {
    this.session?.cancel();
    this.session = null;
    this.notice = null;
  }

  /** Goal, map and analysis are scoped to one video: anything else is discarded. */
  onVideoChange(videoId: string | null): void {
    if (this.session && this.session.videoId !== videoId) {
      this.session.cancel();
      this.session = null;
    }
    if (this.notice && this.notice.videoId !== videoId) this.notice = null;
  }

  active(videoId: string | null): boolean {
    return this.session !== null && this.session.videoId === videoId;
  }

  /** `suspended`: the user changed the speed themselves; Goal Mode never overrides that. */
  decide(videoId: string | null, t: number, pace: Profile, suspended = false): GoalDecision {
    const s = this.session;
    if (!s || s.videoId !== videoId) return { kind: 'off' };
    if (suspended) return { kind: 'hold', note: 'Paused: you chose the speed' };
    if (s.phase === 'failed' || s.phase === 'stopped') return { kind: 'hold', note: "Goal Mode couldn't map this video" };
    // Pacing: the block containing t, by its own scores. The section is only a label.
    const block = s.map.pacingBlockAt(t);
    if (!block) return { kind: 'hold', note: s.phase === 'mapping' ? 'Mapping this part for your goal…' : "This part isn't mapped" };
    const target = goalTarget(block, pace);
    return { kind: 'target', rate: target.rate, label: target.label, block, section: s.map.sectionAt(t) };
  }

  status(videoId: string | null): GoalStatus | null {
    const s = this.session;
    if (s && s.videoId === videoId) {
      const total = s.map.blocks.length;
      const progress = total ? (s.map.rated + s.map.failedCount) / total : 0;
      const message =
        s.phase === 'mapping'
          ? s.breakdownDone
            ? `Mapping… ${Math.floor(progress * 100)}%. Mapped parts are already paced; the timeline on the video shows them.`
            : 'Reading your goal…'
          : s.phase === 'ready'
            ? s.map.failedCount
              ? `Goal Mode is on. ${s.map.failedCount} part(s) couldn't be mapped; their speed is left alone.`
              : 'Goal Mode is on.'
            : s.phase === 'failed'
              ? "Goal Mode couldn't map this video. Playback is unchanged."
              : 'Goal Mode stopped.';
      return { phase: s.phase, goal: s.goal, rated: s.map.rated, total, failed: s.map.failedCount, progress, message };
    }
    if (this.notice && this.notice.videoId === videoId) {
      const message =
        this.notice.phase === 'no-transcript'
          ? "Goal Mode isn't available: this video's captions couldn't be loaded. Playback is unchanged."
          : 'Goal Mode requires Smart Pacing (Chrome\'s on-device AI), which isn\'t available here.';
      return { phase: this.notice.phase, goal: this.notice.goal, rated: 0, total: 0, failed: 0, progress: 0, message };
    }
    return null;
  }
}
