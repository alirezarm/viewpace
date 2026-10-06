/** Small pure checks that decide when ViewPace may act at all. */

/**
 * After the extension is updated or reloaded, content scripts already running in open tabs
 * are orphaned: chrome.runtime.id disappears and they can no longer receive settings.
 */
export function isExtensionAlive(): boolean {
  try {
    return Boolean(globalThis.chrome?.runtime?.id);
  } catch {
    return false; // accessing chrome.* on an invalidated context can throw
  }
}

export type TranscriptKind = 'track' | 'live' | 'none';

/**
 * May ViewPace make a speed decision from this data? A full caption track is enough data
 * everywhere, including genuine pauses or music inside it (handled by the speed algorithm).
 * Live on-screen captions only count once they cover a full analysis window; before that, and
 * with no transcript at all, ViewPace leaves the speed alone.
 */
export function hasEnoughData(kind: TranscriptKind, liveCoverageSec: number, windowSec: number): boolean {
  if (kind === 'track') return true;
  if (kind === 'live') return liveCoverageSec >= windowSec;
  return false;
}

export interface CaptionAttemptContext {
  inAd: boolean;
  msSinceVideoChange: number;
  /** The video the player is actually showing (null if unknown). */
  playerVideoId: string | null;
  urlVideoId: string;
  attempts: number;
  msSinceLastAttempt: number;
}

export const CAPTION_SETTLE_MS = 2000;
export const CAPTION_MAX_ATTEMPTS = 2;
export const CAPTION_RETRY_MS = 15000;

/**
 * Only try to load captions when the attempt can mean something: no ad on screen, the player
 * has finished switching to the URL's video, and at most one retry.
 */
export function captionAttemptAllowed(c: CaptionAttemptContext): boolean {
  if (c.inAd) return false;
  if (c.msSinceVideoChange < CAPTION_SETTLE_MS) return false;
  if (c.playerVideoId !== null && c.playerVideoId !== c.urlVideoId) return false;
  if (c.attempts >= CAPTION_MAX_ATTEMPTS) return false;
  if (c.attempts > 0 && c.msSinceLastAttempt < CAPTION_RETRY_MS) return false;
  return true;
}

export interface CaptionAttemptState {
  count: number;
  last: number;
  running: boolean;
}

/** Caption-loading attempts, kept for the current video only (like all transient data). */
export class CaptionAttempts {
  private attempts = new Map<string, CaptionAttemptState>();

  get(videoId: string): CaptionAttemptState {
    return this.attempts.get(videoId) ?? { count: 0, last: -Infinity, running: false };
  }

  start(videoId: string, now: number): void {
    this.attempts.set(videoId, { count: this.get(videoId).count + 1, last: now, running: true });
  }

  finish(videoId: string): void {
    const a = this.attempts.get(videoId);
    if (a) a.running = false;
  }

  /** Forget attempts for every other video, so returning to one later starts afresh. */
  retainOnly(videoId: string | null): void {
    for (const key of [...this.attempts.keys()]) if (key !== videoId) this.attempts.delete(key);
  }
}

export interface CaptionButtonState {
  /** The CC button exists, is visible and enabled (i.e. the video has captions). */
  available: boolean;
  ccOn: boolean;
  autoEnableCaptions: boolean;
}

/**
 * What a caption attempt would do. 'needs-cc' means nothing can be tried (CC is off and the user
 * turned automatic loading off), so it must not use up one of the limited attempts.
 */
export function captionPlan(b: CaptionButtonState): 'no-captions' | 'needs-cc' | 'load' {
  if (!b.available) return 'no-captions';
  if (!b.ccOn && !b.autoEnableCaptions) return 'needs-cc';
  return 'load';
}
