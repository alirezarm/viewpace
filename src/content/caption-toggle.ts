/**
 * Briefly turn YouTube's CC on so the player fetches the caption track, then put CC back the way
 * it was. Dependencies are injected so the navigation cases can be tested without a browser.
 */

export interface CaptionButton {
  isOn(): boolean;
  click(): void;
}

export interface CaptionToggleDeps {
  /** The player's CC button, looked up fresh each time (YouTube may rebuild the player). */
  button(): CaptionButton | null;
  sleep(ms: number): Promise<void>;
  /** Still on the video this load was started for? */
  isCurrent(): boolean;
  /** Has the player received a caption response for that video since the load started? */
  responded(): boolean;
  /** Longest time CC stays switched on while waiting for the response. */
  waitMs: number;
}

/**
 * 'done': finished on the same video. 'navigated': the user moved to another video meanwhile; CC
 * was still restored, but the caller must not update per-video state. 'no-button': nothing done.
 */
export type CaptionToggleResult = 'done' | 'navigated' | 'no-button';

export async function toggleCaptionsForTrack(d: CaptionToggleDeps): Promise<CaptionToggleResult> {
  const btn = d.button();
  if (!btn) return 'no-button';
  const wasOn = btn.isOn();
  if (wasOn) {
    btn.click(); // off, so that switching on again makes the player fetch the track
    await d.sleep(300);
  }
  if (d.isCurrent()) {
    d.button()?.click(); // on: the player fetches the track
    // Switch back as soon as the player has an answer (even an empty one), or the video changes.
    for (let waited = 0; waited < d.waitMs && !d.responded() && d.isCurrent(); waited += 100) await d.sleep(100);
  }
  // CC on/off is a player-wide preference: always leave it the way ViewPace found it, even if the
  // user moved to another video in the meantime.
  const now = d.button();
  if (now && now.isOn() !== wasOn) now.click();
  return d.isCurrent() ? 'done' : 'navigated';
}
