/**
 * Goal Mode: the one place that starts, stops and restores goals, whichever surface asks (the
 * in-page Goal Map card or the popup), and the only writer of remembered goals. Both surfaces
 * read the same state from here, so they can't drift apart.
 *
 * Restoring: a goal saved for a video is started again (fresh analysis) when the viewer is back
 * on that same video, once per visit, as soon as its captions and the on-device AI are ready.
 * Other videos are only offered the last goal as a suggestion; it is never applied by itself.
 */
import { EMPTY_GOALS, savedGoalFor, suggestionFor, type GoalStore } from '../../shared/goal-store';
import type { GoalController, GoalStatus } from './goal-session';

type StartOptions = Parameters<GoalController['start']>[0];

export interface GoalCoordinatorDeps {
  controller: GoalController;
  storage: {
    load(): Promise<GoalStore>;
    remember(videoId: string, goal: string): Promise<GoalStore>;
    /** Stop on this video: keep its goal as text, but don't restore it. */
    stop(videoId: string): Promise<GoalStore>;
  };
  /**
   * Everything else `GoalController.start` needs for this video (captions, analyzer, playhead…),
   * or a user-facing reason it can't start. `restore` is true when no one clicked Start.
   */
  prepare(videoId: string, goal: string, restore: boolean): StartOptions | { error: string };
}

/** What the in-page card shows. */
export type GoalCardView =
  | { mode: 'hidden' } // Goal Mode can't run here (no on-device AI, ViewPace off…)
  | { mode: 'chip' } // no goal: a one-line "Set a viewing goal" prompt
  | { mode: 'entry'; value: string; suggestion: string | null; canStop: boolean; message: string | null } // typing a goal
  | { mode: 'active'; goal: string }; // a goal is set: shown above the map, with an edit action

export class GoalCoordinator {
  goals: GoalStore = EMPTY_GOALS;
  /** The in-page card is open for typing a goal. */
  editing = false;
  /** Why the last start didn't happen, shown in the card. */
  message: string | null = null;
  private restoreTriedFor: string | null = null;

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

  /** Start (or restart with a new goal): the same path for the card, the popup and restoring. */
  async start(videoId: string | null, text: string, restore = false): Promise<GoalStatus | { error: string } | null> {
    if (!videoId) return { error: 'Open a YouTube video first.' };
    const goal = text.trim();
    const opts = this.deps.prepare(videoId, goal, restore);
    if ('error' in opts) {
      this.message = opts.error;
      return opts;
    }
    const status = await this.deps.controller.start(opts);
    const s = this.deps.controller.session;
    // Remember it only if this very session is still the current one (no navigation or newer goal meanwhile).
    if (status?.phase === 'mapping' && s && s.videoId === videoId && s.goal === status.goal) {
      this.editing = false;
      this.message = null;
      this.goals = await this.deps.storage.remember(videoId, status.goal);
    } else {
      this.message = status?.message ?? null;
    }
    return status;
  }

  /** Stop Goal Mode on this video. Its goal is kept (as a suggestion there) but no longer restored. */
  async stop(videoId: string | null): Promise<void> {
    this.deps.controller.stop();
    this.editing = false;
    this.message = null;
    if (videoId) {
      this.restoreTriedFor = videoId; // don't bring it straight back
      this.goals = await this.deps.storage.stop(videoId);
    }
  }

  /**
   * Called every tick: start this video's saved goal again when it can run. Tried once per visit,
   * so a failed start never loops. Returns true when a restore was started.
   */
  maybeRestore(c: { videoId: string | null; ready: boolean }): boolean {
    const { videoId } = c;
    if (!videoId || this.restoreTriedFor === videoId || this.deps.controller.active(videoId)) return false;
    const saved = savedGoalFor(this.goals, videoId);
    if (!saved || !c.ready) return false;
    this.restoreTriedFor = videoId;
    void this.start(videoId, saved, true);
    return true;
  }

  /** A new video (or none): forget per-visit UI state; the next visit may restore again. */
  onVideoChange(videoId: string | null): void {
    if (this.restoreTriedFor !== videoId) this.restoreTriedFor = null;
    this.editing = false;
    this.message = null;
  }

  setEditing(editing: boolean): void {
    this.editing = editing;
    if (!editing) this.message = null;
  }

  /** The in-page card for this video. `available`: Goal Mode can run here (AI ready, ViewPace on). */
  card(videoId: string | null, available: boolean): GoalCardView {
    const status = this.deps.controller.status(videoId);
    const running = status !== null && (status.phase === 'mapping' || status.phase === 'ready' || status.phase === 'failed');
    const current = running ? status.goal : null;
    if (this.editing) {
      return {
        mode: 'entry',
        value: current ?? '',
        suggestion: current ? null : suggestionFor(this.goals, videoId, current),
        canStop: running,
        message: this.message,
      };
    }
    if (running) return { mode: 'active', goal: status.goal };
    return available ? { mode: 'chip' } : { mode: 'hidden' };
  }
}
