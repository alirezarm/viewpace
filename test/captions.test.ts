import { describe, expect, it } from 'vitest';
import { parseCaptionBody, parseJson3, parseXml, transcriptFromTimedtext } from '../src/content/captions';
import { newTokens } from '../src/content/transcript';

const asrJson3 = JSON.stringify({
  events: [
    { tStartMs: 0, dDurationMs: 5000, id: 1, wpWinPosId: 1, wsWinStyleId: 1 }, // window def, no segs
    { tStartMs: 1000, dDurationMs: 3000, wWinId: 1, segs: [{ utf8: 'hello' }, { utf8: ' world', tOffsetMs: 400 }, { utf8: ' again', tOffsetMs: 900 }] },
    { tStartMs: 2500, wWinId: 1, aAppend: 1, segs: [{ utf8: '\n' }] },
    { tStartMs: 2600, dDurationMs: 2000, wWinId: 1, segs: [{ utf8: 'single' }] },
    { tStartMs: 5000, dDurationMs: 1000, segs: [{ utf8: '[Music]' }] },
  ],
});

describe('parseJson3', () => {
  it('extracts word-level timing from ASR tracks', () => {
    const p = parseJson3(asrJson3);
    expect(p.timing).toBe('word');
    expect(p.words.map((w) => [w.w, w.t])).toEqual([
      ['hello', 1],
      ['world', 1.4],
      ['again', 1.9],
      ['single', 2.6],
    ]);
    expect(p.cues).toHaveLength(3);
  });

  it('distributes words evenly for uploaded captions (no offsets)', () => {
    const body = JSON.stringify({ events: [{ tStartMs: 10000, dDurationMs: 2000, segs: [{ utf8: 'one two three four' }] }] });
    const p = parseJson3(body);
    expect(p.timing).toBe('cue');
    expect(p.words.map((w) => w.t)).toEqual([10, 10.5, 11, 11.5]);
  });
});

describe('parseXml', () => {
  it('parses srv3 with word segments', () => {
    const p = parseXml('<timedtext format="3"><body><p t="1000" d="2000"><s>hi</s><s t="500"> there</s></p></body></timedtext>');
    expect(p.timing).toBe('word');
    expect(p.words).toEqual([
      { t: 1, w: 'hi' },
      { t: 1.5, w: 'there' },
    ]);
  });

  it('parses legacy <text start dur> with entities', () => {
    const p = parseXml('<transcript><text start="2.5" dur="1.5">it&amp;#39;s fine</text></transcript>');
    expect(p.cues[0]).toEqual({ start: 2.5, end: 4, text: "it's fine" });
    expect(p.timing).toBe('cue');
  });
});

describe('parseCaptionBody', () => {
  it('returns null for the empty 200 YouTube sends without a valid pot', () => {
    expect(parseCaptionBody('', 'timedtext')).toBeNull();
    expect(parseCaptionBody('{"events":[]}', 'timedtext')).toBeNull();
  });

  it('parses the transcript panel response', () => {
    const body = JSON.stringify({
      actions: [{ x: { segments: [{ transcriptSegmentRenderer: { startMs: '0', endMs: '2000', snippet: { runs: [{ text: 'a b' }] } } }] } }],
    });
    const p = parseCaptionBody(body, 'transcript-panel');
    expect(p?.cues).toEqual([{ start: 0, end: 2, text: 'a b' }]);
  });
});

describe('transcriptFromTimedtext', () => {
  it('reads video id, language and kind from the URL', () => {
    const t = transcriptFromTimedtext('/api/timedtext?v=abc&lang=en&kind=asr&fmt=json3&pot=x', asrJson3);
    expect(t).toMatchObject({ videoId: 'abc', lang: 'en', kind: 'asr', timing: 'word', source: 'player-track' });
  });
});

describe('newTokens (rolling live captions)', () => {
  it('returns only newly appended words', () => {
    expect(newTokens(['a', 'b', 'c'], ['b', 'c', 'd', 'e'])).toEqual(['d', 'e']);
    expect(newTokens([], ['x'])).toEqual(['x']);
    expect(newTokens(['a', 'b'], ['a', 'b'])).toEqual([]);
    expect(newTokens(['a'], ['q', 'r'])).toEqual(['q', 'r']);
  });
});
