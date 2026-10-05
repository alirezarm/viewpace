import type { TimedWord, Transcript } from '../shared/types';
import { parseCaptionBody, tokenize, transcriptFromTimedtext } from './captions';

function videoIdFromUrl(url: string): string | null {
  try {
    return new URL(url, 'https://www.youtube.com').searchParams.get('v');
  } catch {
    return null;
  }
}

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

/** Transcripts kept in memory per tab (the current video plus a few recent ones). */
export const MAX_TRACKS = 5;
/** A jump in live-caption time larger than this starts a new continuous run (seek, CC off). */
const LIVE_GAP_SEC = 30;

/**
 * Holds the best available transcript per video:
 *  1. full timed track captured from the player (enables lookahead), or
 *  2. words observed live in the on-screen caption DOM (reactive only: the past, not the future).
 */
export class TranscriptStore {
  private tracks = new Map<string, Transcript>();
  private live = new Map<string, TimedWord[]>();
  /** Media time where the current continuous run of live-caption observations began. */
  private liveRunStart = new Map<string, number>();
  /** How many caption responses (even empty ones) the player received per video. */
  private responses = new Map<string, number>();
  lastCaptureEmpty = false;

  ingestTimedtext(url: string, body: string): Transcript | null {
    const id = videoIdFromUrl(url);
    if (id) this.responses.set(id, (this.responses.get(id) ?? 0) + 1);
    const t = transcriptFromTimedtext(url, body);
    this.lastCaptureEmpty = body.trim().length === 0;
    if (!t) return null;
    // Speech rate must be measured on what is actually spoken: keep an original-language
    // track over an auto-translated one.
    const existing = this.tracks.get(t.videoId);
    if (existing && !existing.translated && t.translated) return null;
    this.setTrack(t);
    return t;
  }

  /** Caption responses the player has received for this video so far (with or without content). */
  responseCount(videoId: string): number {
    return this.responses.get(videoId) ?? 0;
  }

  private setTrack(t: Transcript): void {
    this.tracks.delete(t.videoId); // re-insert as most recent
    this.tracks.set(t.videoId, t);
    while (this.tracks.size > MAX_TRACKS) this.tracks.delete(this.tracks.keys().next().value!);
  }

  ingestTranscriptPanel(videoId: string, body: string): Transcript | null {
    const parsed = parseCaptionBody(body, 'transcript-panel');
    if (!parsed) return null;
    // Prefer a word-timed player track if we already have one.
    if (this.tracks.get(videoId)?.timing === 'word') return null;
    const t: Transcript = { videoId, lang: '?', kind: '', translated: false, source: 'transcript-panel', ...parsed };
    this.setTrack(t);
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
    let seekedBack = false;
    while (arr.length > 0 && arr[arr.length - 1]!.t > t + 0.5) {
      arr.pop();
      seekedBack = true;
    }
    const last = arr[arr.length - 1];
    if (!last || seekedBack || t - last.t > LIVE_GAP_SEC) this.liveRunStart.set(videoId, t);
    for (const w of fresh) arr.push({ t, w });
    if (arr.length > 4000) arr.splice(0, arr.length - 4000);
  }

  /** How many seconds of continuous live captions lead up to media time `t`. */
  liveCoverage(videoId: string, t: number): number {
    const start = this.liveRunStart.get(videoId);
    return start === undefined ? 0 : Math.max(0, t - start);
  }

  forget(videoId: string): void {
    this.live.delete(videoId);
    this.liveRunStart.delete(videoId);
  }
}
