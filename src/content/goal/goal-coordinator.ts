/**
 * Goal Mode: the one place that starts, resumes and stops goals, whichever surface asks (the
 * in-page ViewPace card or the popup), and the only writer of remembered goals. Both surfaces
 * read the same state from here, so they can't drift apart.
 *
 * Two separate things:
 *  - a saved goal: text remembered for a video (goal-store), shown again on that video;
 *  - active Goal Mode: a running GoalController session for the current video.
 * A saved goal never starts Goal Mode by itself: only Start or Resume does (so no analysis runs
 * on a reload or a return to the video until the viewer asks). Stop ends the session and keeps
 * the saved goal. Other videos are only offered the last goal as a suggestion.
 */
import { EMPTY_GOALS, savedGoalFor, suggestionFor, type GoalStore } from '../../shared/goal-store';
import type { GoalController, GoalStatus } from './goal-session';

type StartOptions = Parameters<GoalController['start']>[0];

export interface GoalCoordinatorDeps {
  controller: GoalController;
  storage: {
    load(): Promise<GoalStore>;
    remember(videoId: string, goal: string): Promise<GoalStore>;
  };
  /**
   * Everything else `GoalController.start` needs for this video (captions, analyzer, playhead…),
   * or a user-facing reason it can't start.
   */
  prepare(videoId: string, goal: string): StartOptions | { error: string };
}

/** What the goal part of the ViewPace card shows. */
export type GoalCardView =
  | { mode: 'hidden' } // Goal Mode can't run here (no on-device AI, ViewPace off…)
  | { mode: 'chip' } // no goal: a one-line "Set a viewing goal" prompt
  | { mode: 'saved'; goal: string; message: string | null } // this video's saved goal, not running: Resume or edit (and why the last Resume failed)
  | { mode: 'entry'; value: string; suggestion: string | null; canStop: boolean; message: string | null } // typing a goal
  | { mode: 'active'; goal: string }; // Goal Mode is running with this goal: shown above the map

/** A short, user-facing reason a start didn't happen, from what GoalController reported. */
export function startFailure(status: GoalStatus | null): string {
  if (status?.phase === 'no-transcript') return "Couldn't read this video's captions. Play it for a moment, then try again.";
  if (status?.phase === 'no-ai') return "Chrome's on-device AI isn't available right now. Try again later.";
  return "Couldn't start Goal Mode. Try again.";
}

export class GoalCoordinator {
  goals: GoalStore = EMPTY_GOALS;
  /** The goal input is open. */
  editing = false;
  /** Why the last start didn't happen, shown with the input. */
  message: string | null = null;

  constructor(private deps: GoalCoordinatorDeps) {}

  async init(): Promise<void> {
    this.goals = await this.deps.storage.load();
  }

  /** Remembered goals changed elsewhere (e.g. another tab). */
  setGoals(goals: GoalStore): void {
    this.goals = goals;
  }

  status(videoId: string | null): GoalStatus | null {
    return this.deps.controller.status(videoId);
  }

  /** Start (or restart with a new goal): the same path for the card, the popup and Resume. */
  async start(videoId: string | null, text: string): Promise<GoalStatus | { error: string } | null> {
    if (!videoId) return { error: 'Open a YouTube video first.' };
    const goal = text.trim();
    const opts = this.deps.prepare(videoId, goal);
    if ('error' in opts) {
      this.message = opts.error;
      return opts;
    }
    let status: GoalStatus | null;
    try {
      status = await this.deps.controller.start(opts);
    } catch {
      this.message = startFailure(null);
      return { error: this.message };
    }
    const s = this.deps.controller.session;
    // Remember it only if this very session is still the current one (no navigation or newer goal meanwhile).
    if (status?.phase === 'mapping' && s && s.videoId === videoId && s.goal === status.goal) {
      this.editing = false;
      this.message = null;
      this.goals = await this.deps.storage.remember(videoId, status.goal);
    } else if (!status || status.phase === 'no-transcript' || status.phase === 'no-ai') {
      // Didn't start (no captions yet, no on-device AI…): say why, keep the goal, leave Resume/Start to retry.
      this.message = startFailure(status);
    }
    return status;
  }

  /** Resume: start Goal Mode again with this video's saved goal (fresh analysis). */
  async resume(videoId: string | null): Promise<GoalStatus | { error: string } | null> {
    const saved = savedGoalFor(this.goals, videoId);
    if (!saved) return { error: 'There is no saved goal for this video.' };
    return this.start(videoId, saved);
  }

  /** Stop Goal Mode on this video. The saved goal is kept, ready to Resume. */
  stop(): void {
    this.deps.controller.stop();
    this.editing = false;
    this.message = null;
  }

  /** A new video (or none): close the input. Its saved goal (if any) waits for Resume. */
  onVideoChange(): void {
    this.editing = false;
    this.message = null;
  }

  setEditing(editing: boolean): void {
    this.editing = editing;
    if (!editing) this.message = null;
  }

  /** The goal part of the card for this video. `available`: Goal Mode can run here (AI ready, ViewPace on). */
  card(videoId: string | null, available: boolean): GoalCardView {
    const status = this.deps.controller.status(videoId);
    const running = status !== null && (status.phase === 'mapping' || status.phase === 'ready' || status.phase === 'failed');
    const current = running ? status.goal : null;
    const saved = savedGoalFor(this.goals, videoId);
    if (this.editing) {
      return {
        mode: 'entry',
        value: current ?? saved ?? '',
        suggestion: current || saved ? null : suggestionFor(this.goals, videoId, null),
        canStop: running,
        message: this.message,
      };
    }
    if (running) return { mode: 'active', goal: status.goal };
    if (!available) return { mode: 'hidden' };
    return saved ? { mode: 'saved', goal: saved, message: this.message } : { mode: 'chip' };
  }
}
