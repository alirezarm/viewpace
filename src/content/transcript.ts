import type { TimedWord, Transcript } from '../shared/types';
import { parseCaptionBody, tokenize, transcriptFromTimedtext } from './captions';

/** Tokens in `cur` that were not already shown at the end of `prev` (rolling caption display). */
export function newTokens(prev: string[], cur: string[]): string[] {
  const max = Math.min(prev.length, cur.length);
  for (let k = max; k > 0; k--) {
    let match = true;
    for (let i = 0; i < k; i++) {
      if (prev[prev.length - k + i] !== cur[i]) {
        match = false;
        break;
      }
    }
    if (match) return cur.slice(k);
  }
  return cur;
}

/**
 * Holds the best available transcript per video:
 *  1. full timed track captured from the player (enables lookahead), or
 *  2. words observed live in the on-screen caption DOM (reactive only: the past, not the future).
 */
export class TranscriptStore {
  private tracks = new Map<string, Transcript>();
  private live = new Map<string, TimedWord[]>();
  lastCaptureEmpty = false;

  ingestTimedtext(url: string, body: string): Transcript | null {
    const t = transcriptFromTimedtext(url, body);
    this.lastCaptureEmpty = body.trim().length === 0;
    if (t) this.tracks.set(t.videoId, t);
    return t;
  }

  ingestTranscriptPanel(videoId: string, body: string): Transcript | null {
    const parsed = parseCaptionBody(body, 'transcript-panel');
    if (!parsed) return null;
    // Prefer a word-timed player track if we already have one.
    if (this.tracks.get(videoId)?.timing === 'word') return null;
    const t: Transcript = { videoId, lang: '?', kind: '', source: 'transcript-panel', ...parsed };
    this.tracks.set(videoId, t);
    return t;
  }

  track(videoId: string): Transcript | null {
    return this.tracks.get(videoId) ?? null;
  }

  liveWords(videoId: string): TimedWord[] {
    return this.live.get(videoId) ?? [];
  }

  /** Record caption text currently on screen at media time `t`. */
  observeLive(videoId: string, prevText: string, curText: string, t: number): void {
    const fresh = newTokens(tokenize(prevText), tokenize(curText));
    if (fresh.length === 0) return;
    let arr = this.live.get(videoId);
    if (!arr) this.live.set(videoId, (arr = []));
    // After a backwards seek, drop observations that are now "in the future".
    while (arr.length > 0 && arr[arr.length - 1]!.t > t + 0.5) arr.pop();
    for (const w of fresh) arr.push({ t, w });
    if (arr.length > 4000) arr.splice(0, arr.length - 4000);
  }

  forget(videoId: string): void {
    this.live.delete(videoId);
  }
}
