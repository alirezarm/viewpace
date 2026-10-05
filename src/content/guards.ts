/** Small pure checks that decide when AutoSpeed may act at all. */

/**
 * H1: after the extension is updated or reloaded, content scripts already running in open tabs
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
 * H3: may AutoSpeed make a speed decision from this data? A full caption track is enough data
 * everywhere, including genuine pauses or music inside it (handled by the speed algorithm).
 * Live on-screen captions only count once they cover a full analysis window; before that, and
 * with no transcript at all, AutoSpeed leaves the speed alone.
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
 * H4: only try to load captions when the attempt can mean something: no ad on screen, the player
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
