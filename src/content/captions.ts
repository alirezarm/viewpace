import type { Cue, TimedWord, TimingSource, Transcript } from '../shared/types';

export interface ParsedCaptions {
  timing: TimingSource;
  words: TimedWord[];
  cues: Cue[];
}

const NON_SPEECH = /^\[[^\]]*\]$|^\([^)]*\)$|^♪+$/;

export function isNonSpeech(token: string): boolean {
  return NON_SPEECH.test(token);
}

/** Tokens that count as spoken words (contain a letter or digit, not a [Music]-style tag). */
export function tokenize(text: string): string[] {
  return text
    .replace(/\[[^\]]*\]/g, ' ')
    .split(/\s+/)
    .filter((t) => /[\p{L}\p{N}]/u.test(t));
}

/** Spread a cue's words evenly across its duration (used when there is no word-level timing). */
function distribute(cue: Cue): TimedWord[] {
  const toks = tokenize(cue.text);
  const dur = Math.max(0.01, cue.end - cue.start);
  return toks.map((w, i) => ({ t: cue.start + (dur * i) / toks.length, w }));
}

function finish(cues: Cue[], words: TimedWord[] | null): ParsedCaptions {
  cues.sort((a, b) => a.start - b.start);
  if (words && words.length > 0) {
    words.sort((a, b) => a.t - b.t);
    return { timing: 'word', words, cues };
  }
  // Cues can overlap (e.g. two speakers), so words spread across them must be sorted again:
  // lookups downstream binary-search by time.
  return { timing: 'cue', words: cues.flatMap(distribute).sort((a, b) => a.t - b.t), cues };
}

// ---------- json3 (what the web player requests: fmt=json3) ----------

interface Json3Seg {
  utf8?: string;
  tOffsetMs?: number;
}
interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  aAppend?: number;
  segs?: Json3Seg[];
}

export function parseJson3(body: string): ParsedCaptions {
  const data = JSON.parse(body) as { events?: Json3Event[] };
  const cues: Cue[] = [];
  const words: TimedWord[] = [];
  let hasWordOffsets = false;

  for (const ev of data.events ?? []) {
    if (!ev.segs || ev.aAppend) continue;
    const start = (ev.tStartMs ?? 0) / 1000;
    const end = start + (ev.dDurationMs ?? 0) / 1000;
    const text = ev.segs.map((s) => s.utf8 ?? '').join('').trim();
    if (!text) continue;
    cues.push({ start, end, text });
    // Auto-generated (ASR) tracks carry per-word offsets: several segs, later ones with tOffsetMs.
    // Collect seg-timed words for every event; they are only used if the track has offsets.
    if (ev.segs.some((s) => s.tOffsetMs !== undefined)) hasWordOffsets = true;
    for (const seg of ev.segs) {
      const segStart = start + (seg.tOffsetMs ?? 0) / 1000;
      for (const w of tokenize(seg.utf8 ?? '')) words.push({ t: segStart, w });
    }
  }
  return finish(cues, hasWordOffsets ? words : null);
}

// ---------- XML formats (srv3 `<p t d><s t>` and legacy `<text start dur>`) ----------

function decodeEntities(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)));
}

function attr(tag: string, name: string): number | null {
  const m = new RegExp(`\\b${name}="([\\d.]+)"`).exec(tag);
  return m?.[1] !== undefined ? Number(m[1]) : null;
}

export function parseXml(body: string): ParsedCaptions {
  const cues: Cue[] = [];
  const words: TimedWord[] = [];
  let hasWordOffsets = false;

  // srv3: times in ms
  for (const m of body.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g)) {
    const [, attrs = '', inner = ''] = m;
    const t = attr(attrs, 't');
    if (t === null) continue;
    const start = t / 1000;
    const end = start + (attr(attrs, 'd') ?? 0) / 1000;
    const text = decodeEntities(inner).trim();
    if (!text) continue;
    cues.push({ start, end, text });
    const segs = [...inner.matchAll(/<s\b([^>]*)>([\s\S]*?)<\/s>/g)];
    if (segs.length > 0) {
      hasWordOffsets = true;
      for (const [, sAttrs = '', sText = ''] of segs) {
        const st = start + (attr(sAttrs, 't') ?? 0) / 1000;
        for (const w of tokenize(decodeEntities(sText))) words.push({ t: st, w });
      }
    } else {
      words.push(...distribute({ start, end, text }));
    }
  }
  // legacy: times in seconds
  for (const m of body.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)) {
    const [, attrs = '', inner = ''] = m;
    const start = attr(attrs, 'start');
    if (start === null) continue;
    const text = decodeEntities(decodeEntities(inner)).trim();
    if (text) cues.push({ start, end: start + (attr(attrs, 'dur') ?? 0), text });
  }
  return finish(cues, hasWordOffsets ? words : null);
}

// ---------- youtubei get_transcript (the "Show transcript" panel) ----------

export function parseTranscriptPanel(body: string): ParsedCaptions {
  const cues: Cue[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const obj = node as Record<string, unknown>;
    const seg = obj.transcriptSegmentRenderer as
      | { startMs?: string; endMs?: string; snippet?: { runs?: { text?: string }[]; simpleText?: string } }
      | undefined;
    if (seg?.startMs !== undefined) {
      const text = (seg.snippet?.runs?.map((r) => r.text ?? '').join('') ?? seg.snippet?.simpleText ?? '').trim();
      if (text) cues.push({ start: Number(seg.startMs) / 1000, end: Number(seg.endMs ?? seg.startMs) / 1000, text });
      return;
    }
    Object.values(obj).forEach(walk);
  };
  walk(JSON.parse(body));
  return finish(cues, null);
}

/** Dispatch on body shape; returns null for empty or unparseable bodies. */
export function parseCaptionBody(body: string, from: 'timedtext' | 'transcript-panel'): ParsedCaptions | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  try {
    const parsed =
      from === 'transcript-panel'
        ? parseTranscriptPanel(trimmed)
        : trimmed.startsWith('{')
          ? parseJson3(trimmed)
          : parseXml(trimmed);
    return parsed.cues.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

/** Build a Transcript from a captured timedtext request. */
export function transcriptFromTimedtext(url: string, body: string): Transcript | null {
  let u: URL;
  try {
    u = new URL(url, 'https://www.youtube.com');
  } catch {
    return null;
  }
  const videoId = u.searchParams.get('v');
  if (!videoId) return null;
  const parsed = parseCaptionBody(body, 'timedtext');
  if (!parsed) return null;
  return {
    videoId,
    lang: u.searchParams.get('tlang') ?? u.searchParams.get('lang') ?? '?',
    kind: u.searchParams.get('kind') ?? '',
    translated: u.searchParams.has('tlang'),
    source: 'player-track',
    ...parsed,
  };
}
