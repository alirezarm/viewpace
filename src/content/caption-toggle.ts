/**
 * Briefly turn YouTube's CC on so the player fetches the caption track, then put CC back the way
 * it was. Dependencies are injected so the navigation cases can be tested without a browser.
 */

export interface CaptionButton {
  isOn(): boolean;
  click(): void;
  /** Still in the page? False once YouTube has replaced the player. */
  isConnected(): boolean;
}

export interface CaptionToggleDeps {
  /** The player's CC button at the start of the operation. */
  button(): CaptionButton | null;
  sleep(ms: number): Promise<void>;
  /** Still on the video (and player) this load was started for? Must read live state. */
  isCurrent(): boolean;
  /** Has the player received a caption response for that video since the load started? */
  responded(): boolean;
  /** Longest time CC stays switched on while waiting for the response. */
  waitMs: number;
}

/**
 * 'done': finished on the same video. 'navigated': the user moved to another video (or YouTube
 * replaced the player) meanwhile; the caller must not update per-video state. 'no-button': nothing done.
 */
export type CaptionToggleResult = 'done' | 'navigated' | 'no-button';

export async function toggleCaptionsForTrack(d: CaptionToggleDeps): Promise<CaptionToggleResult> {
  const btn = d.button();
  if (!btn) return 'no-button';
  const wasOn = btn.isOn();
  let leftOn = wasOn; // the state ViewPace has put this button in
  const click = () => {
    btn.click();
    leftOn = !leftOn;
  };
  const stillHere = () => d.isCurrent() && btn.isConnected();

  if (wasOn) {
    click(); // off, so that switching on again makes the player fetch the track
    await d.sleep(300);
  }
  if (stillHere()) {
    if (!leftOn) click(); // on: the player fetches the track
    // Switch back as soon as the player has an answer (even an empty one), or the video changes.
    for (let waited = 0; waited < d.waitMs && !d.responded() && stillHere(); waited += 100) await d.sleep(100);
  }
  // Undo only ViewPace's own change: on the same button (never on a replaced player), and only if
  // nobody else has changed CC since. Otherwise leave CC as it is.
  if (leftOn !== wasOn && btn.isConnected() && btn.isOn() === leftOn) click();
  return d.isCurrent() ? 'done' : 'navigated';
}
