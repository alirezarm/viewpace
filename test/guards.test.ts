import { afterEach, describe, expect, it } from 'vitest';
import {
  CAPTION_RETRY_MS,
  CAPTION_SETTLE_MS,
  captionAttemptAllowed,
  hasEnoughData,
  isExtensionAlive,
  type CaptionAttemptContext,
} from '../src/content/guards';

describe('H1: orphaned content script detection', () => {
  const g = globalThis as { chrome?: unknown };
  afterEach(() => delete g.chrome);

  it('is alive while chrome.runtime.id exists', () => {
    g.chrome = { runtime: { id: 'abc' } };
    expect(isExtensionAlive()).toBe(true);
  });
  it('is dead once the extension was reloaded/updated', () => {
    g.chrome = { runtime: {} };
    expect(isExtensionAlive()).toBe(false);
    delete g.chrome;
    expect(isExtensionAlive()).toBe(false);
  });
  it('is dead when touching chrome.runtime throws', () => {
    g.chrome = {
      get runtime() {
        throw new Error('Extension context invalidated.');
      },
    };
    expect(isExtensionAlive()).toBe(false);
  });
});

describe('H3: no transcript or not enough data = no speed change', () => {
  it('never decides without a transcript', () => {
    expect(hasEnoughData('none', 0, 20)).toBe(false);
  });
  it('decides from a full caption track, including its pauses', () => {
    expect(hasEnoughData('track', 0, 20)).toBe(true);
  });
  it('waits until live captions cover a full window', () => {
    expect(hasEnoughData('live', 5, 20)).toBe(false);
    expect(hasEnoughData('live', 20, 20)).toBe(true);
  });
});

describe('H4: when to try loading captions', () => {
  const ok: CaptionAttemptContext = {
    inAd: false,
    msSinceVideoChange: 10_000,
    playerVideoId: 'abc',
    urlVideoId: 'abc',
    attempts: 0,
    msSinceLastAttempt: Infinity,
  };
  it('allows a normal first attempt', () => {
    expect(captionAttemptAllowed(ok)).toBe(true);
  });
  it('never tries during an ad', () => {
    expect(captionAttemptAllowed({ ...ok, inAd: true })).toBe(false);
  });
  it('waits for the player to finish switching videos', () => {
    expect(captionAttemptAllowed({ ...ok, msSinceVideoChange: CAPTION_SETTLE_MS - 1 })).toBe(false);
    expect(captionAttemptAllowed({ ...ok, playerVideoId: 'previous-video' })).toBe(false);
  });
  it('still tries when the player video id is unknown', () => {
    expect(captionAttemptAllowed({ ...ok, playerVideoId: null })).toBe(true);
  });
  it('retries once, after a pause', () => {
    expect(captionAttemptAllowed({ ...ok, attempts: 1, msSinceLastAttempt: 1000 })).toBe(false);
    expect(captionAttemptAllowed({ ...ok, attempts: 1, msSinceLastAttempt: CAPTION_RETRY_MS })).toBe(true);
    expect(captionAttemptAllowed({ ...ok, attempts: 2, msSinceLastAttempt: CAPTION_RETRY_MS })).toBe(false);
  });
});
