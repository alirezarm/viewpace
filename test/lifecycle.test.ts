import { describe, expect, it } from 'vitest';
import { CAPTION_MAX_ATTEMPTS, CaptionAttempts, captionAttemptAllowed, captionPlan } from '../src/content/guards';
import { TranscriptStore } from '../src/content/transcript';
import { ReplayBuffer } from '../src/page/replay-buffer';

const json3 = (text: string) => JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: text }] }] });
const url = (v: string) => `/api/timedtext?v=${v}&lang=en&fmt=json3`;

describe('transient data is kept for the current video only', () => {
  it('drops every other video on a video change, keeping what was captured for the new one', () => {
    const s = new TranscriptStore();
    s.ingestTimedtext(url('A'), json3('old video words'));
    s.observeLive('A', '', 'old live words', 10);
    // The new video's track can arrive before ViewPace notices the navigation:
    s.ingestTimedtext(url('B'), json3('new video words'));

    s.retainOnly('B');

    expect(s.track('A')).toBeNull();
    expect(s.liveWords('A')).toEqual([]);
    expect(s.liveCoverage('A', 20)).toBe(0);
    expect(s.responseCount('A')).toBe(0);
    expect(s.track('B')).not.toBeNull();
    expect(s.responseCount('B')).toBe(1);
  });

  it('keeps nothing when leaving watch pages', () => {
    const s = new TranscriptStore();
    s.ingestTimedtext(url('A'), json3('words'));
    s.retainOnly(null);
    expect(s.track('A')).toBeNull();
  });
});

describe('revisiting an old video', () => {
  it('allows a fresh caption attempt after its attempts were used up', () => {
    const attempts = new CaptionAttempts();
    for (let i = 0; i < CAPTION_MAX_ATTEMPTS; i++) {
      attempts.start('A', i * 20_000);
      attempts.finish('A');
    }
    const ctx = (count: number) => ({
      inAd: false,
      msSinceVideoChange: 10_000,
      playerVideoId: 'A',
      urlVideoId: 'A',
      attempts: count,
      msSinceLastAttempt: 1000,
    });
    expect(captionAttemptAllowed(ctx(attempts.get('A').count))).toBe(false);

    attempts.retainOnly('B'); // watched another video
    attempts.retainOnly('A'); // came back to A

    expect(attempts.get('A').count).toBe(0);
    expect(captionAttemptAllowed({ ...ctx(attempts.get('A').count), msSinceLastAttempt: Infinity })).toBe(true);
  });
});

describe('page hook replay buffer', () => {
  it('keeps captures for the newest video only', () => {
    const b = new ReplayBuffer<string>();
    b.push('A-track', 'A');
    b.push('A-panel', 'A');
    b.push('B-track', 'B');
    expect(b.all()).toEqual(['B-track']);
  });
  it('keeps captures of unknown video and stays bounded', () => {
    const b = new ReplayBuffer<string>(3);
    b.push('unknown', null);
    b.push('A1', 'A');
    b.push('A2', 'A');
    b.push('A3', 'A');
    expect(b.all()).toEqual(['A1', 'A2', 'A3']);
  });
});

describe('caption attempts with automatic loading off', () => {
  it('does not use up an attempt when nothing can be tried', () => {
    expect(captionPlan({ available: true, ccOn: false, autoEnableCaptions: false })).toBe('needs-cc');
  });
  it('loads once the user turns the setting (or CC) on', () => {
    expect(captionPlan({ available: true, ccOn: false, autoEnableCaptions: true })).toBe('load');
    expect(captionPlan({ available: true, ccOn: true, autoEnableCaptions: false })).toBe('load');
  });
  it('reports a video without captions as such', () => {
    expect(captionPlan({ available: false, ccOn: false, autoEnableCaptions: true })).toBe('no-captions');
  });
});
