/**
 * Who owns the playback speed. ViewPace never fights a speed change it didn't make: such a
 * change is treated as the user's choice and adaptation is suspended. The only exceptions are
 * known YouTube resets (right after a video (re)loads or an ad ends), where ViewPace re-applies
 * its own speed if it was in control. Pure logic: no DOM, no timers.
 */

export type RateChangeAction =
  | 'own' // ViewPace caused it
  | 'ignore' // nothing to do (ad, YouTube settling a new video, change while not controlling)
  | 'reapply' // known YouTube reset while ViewPace was in control: put ViewPace's speed back
  | 'suspend' // someone else chose a speed: stop adapting until the user resumes
  | 'resume'; // a temporary change (e.g. press-and-hold) went back to ViewPace's speed

/** How long after a (re)load or an ad YouTube may still be setting its own speed. */
export const SETTLE_MS = 3000;
/** A suspension that returns to ViewPace's speed this quickly was temporary (e.g. hold-for-2×). */
export const TEMPORARY_MS = 15000;
const SAME = 0.01;

export class RateOwner {
  /** The user's own speed in this tab: restored when ViewPace lets go. */
  userRate: number | null = null;
  /** The speed ViewPace set and currently owns; null when not in control. */
  applied: number | null = null;
  /** The user (or another tool) chose a speed on this video; ViewPace waits for Resume. */
  suspended = false;

  private suspendedFrom: number | null = null;
  private suspendedAt = -Infinity;
  private settleUntil = -Infinity;
  private restoring: number | null = null;

  get controlling(): boolean {
    return this.applied !== null;
  }

  /** ViewPace is about to set `rate` while the video plays at `current`. */
  take(rate: number, current: number): void {
    if (this.applied === null) this.userRate = current; // remember the user's speed before the first change
    this.applied = rate;
  }

  /** Let go of the speed. Returns the user's speed to restore, or null to leave it as it is. */
  release(): number | null {
    const restore = this.applied !== null ? this.userRate : null;
    this.applied = null;
    this.restoring = restore;
    return restore;
  }

  /** YouTube may set its own speed for a short while (new video, reload, ad ended). */
  settle(now: number): void {
    this.settleUntil = now + SETTLE_MS;
  }

  /** A different video: forget per-video state. Call release() first if controlling. */
  newVideo(now: number): void {
    this.suspended = false;
    this.suspendedFrom = null;
    this.settle(now);
  }

  resume(): void {
    this.suspended = false;
    this.suspendedFrom = null;
  }

  /**
   * A playback-rate change happened. `ignoreExternal` covers moments when outside changes are
   * expected and not a user choice (ads) or simply not ViewPace's business (ViewPace is off).
   */
  onRateChange(observed: number, now: number, ignoreExternal: boolean): RateChangeAction {
    if (this.restoring !== null && Math.abs(observed - this.restoring) < SAME) {
      this.restoring = null;
      return 'own';
    }
    if (this.applied !== null && Math.abs(observed - this.applied) < SAME) return 'own';
    if (ignoreExternal) return 'ignore';

    if (this.suspended) {
      if (this.suspendedFrom !== null && Math.abs(observed - this.suspendedFrom) < SAME && now - this.suspendedAt < TEMPORARY_MS) {
        this.applied = this.suspendedFrom;
        this.resume();
        return 'resume';
      }
      this.userRate = observed;
      return 'ignore';
    }

    if (now < this.settleUntil) {
      if (this.applied !== null) return 'reapply';
      this.userRate = observed; // YouTube applying its own (the user's) speed to a new video
      return 'ignore';
    }

    // Not ViewPace, not an ad, not a known reset: the user (or another tool) chose this speed.
    this.suspendedFrom = this.applied;
    this.suspendedAt = now;
    this.suspended = true;
    this.applied = null;
    this.userRate = observed;
    return 'suspend';
  }
}
