import { describe, expect, it } from 'vitest';
import { SAFETY_MAX_TRACKS, TranscriptStore } from '../src/content/transcript';

const json3 = (text: string) => JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: text }] }] });
const url = (v: string, extra = '') => `/api/timedtext?v=${v}&lang=en&fmt=json3${extra}`;

describe('Live caption coverage', () => {
  it('grows with continuous observation and restarts after a jump', () => {
    const s = new TranscriptStore();
    s.observeLive('v', '', 'hello there', 100);
    s.observeLive('v', 'hello there', 'hello there friend', 110);
    expect(s.liveCoverage('v', 112)).toBe(12);
    s.observeLive('v', '', 'far ahead', 500); // forward seek or CC turned back on
    expect(s.liveCoverage('v', 505)).toBe(5);
  });
  it('restarts after seeking backwards', () => {
    const s = new TranscriptStore();
    s.observeLive('v', '', 'one two', 100);
    s.observeLive('v', '', 'three four', 130);
    s.observeLive('v', '', 'back again', 50);
    expect(s.liveCoverage('v', 52)).toBe(2);
  });
  it('is zero before any captions were seen', () => {
    expect(new TranscriptStore().liveCoverage('v', 100)).toBe(0);
  });
});

describe('Prefer original-language captions', () => {
  it('keeps the original track when a translation arrives later', () => {
    const s = new TranscriptStore();
    s.ingestTimedtext(url('v'), json3('original words'));
    s.ingestTimedtext(url('v', '&tlang=de'), json3('übersetzte wörter'));
    expect(s.track('v')?.translated).toBe(false);
  });
  it('uses a translation if that is all there is, then upgrades', () => {
    const s = new TranscriptStore();
    s.ingestTimedtext(url('v', '&tlang=de'), json3('übersetzt'));
    expect(s.track('v')?.translated).toBe(true);
    s.ingestTimedtext(url('v'), json3('original'));
    expect(s.track('v')?.translated).toBe(false);
  });
});

describe('Safety limit on stored caption tracks', () => {
  // Between video changes, captures for other videos (ads, possible inline previews) still get
  // stored; the cap keeps that bounded.
  it(`holds at most ${SAFETY_MAX_TRACKS} tracks, dropping the oldest`, () => {
    const s = new TranscriptStore();
    for (let i = 0; i < SAFETY_MAX_TRACKS + 2; i++) s.ingestTimedtext(url(`other${i}`), json3('words here'));
    expect(s.track('other0')).toBeNull();
    expect(s.track('other1')).toBeNull();
    expect(s.track(`other${SAFETY_MAX_TRACKS + 1}`)).not.toBeNull();
  });

  it('never drops the most recent capture, e.g. the current video after a burst of ad captures', () => {
    const s = new TranscriptStore();
    for (let i = 0; i < SAFETY_MAX_TRACKS * 2; i++) s.ingestTimedtext(url(`ad${i}`), json3('ad words'));
    s.ingestTimedtext(url('current'), json3('video words'));
    expect(s.track('current')).not.toBeNull();
  });
});

describe('Caption responses are counted even when empty', () => {
  it('counts empty and full responses per video', () => {
    const s = new TranscriptStore();
    s.ingestTimedtext(url('v'), '');
    expect(s.responseCount('v')).toBe(1);
    expect(s.track('v')).toBeNull();
    s.ingestTimedtext(url('v'), json3('words'));
    expect(s.responseCount('v')).toBe(2);
  });
});
