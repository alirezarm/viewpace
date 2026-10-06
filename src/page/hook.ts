/**
 * Runs in the page's MAIN world at document_start.
 *
 * YouTube caption URLs now require a single-use proof-of-origin token (`pot`) minted by the
 * player, so re-fetching a caption track from the extension returns an empty 200. Instead we
 * passively copy the response bodies of requests the player itself makes:
 *   - /api/timedtext            (caption track, fetched when CC is turned on)
 *   - /youtubei/v1/get_transcript (when the user opens "Show transcript")
 * and hand them to the isolated content script via window.postMessage.
 */
import { PAGE_TAG, type ContentToPage, type PageToContent } from '../shared/messages';
import { ReplayBuffer } from './replay-buffer';

type CaptureType = 'timedtext' | 'transcript-panel';

const buffered = new ReplayBuffer<PageToContent>();

/** The video a capture belongs to: the request's `v` for caption tracks, else the page's video. */
/** The video the page shows right now (call when a request starts, not when it completes). */
function pageVideoId(): string | null {
  try {
    return new URLSearchParams(location.search).get('v');
  } catch {
    return null;
  }
}

/** The video a capture belongs to: the request's `v` for caption tracks, else the page's video at request time. */
function captureVideoId(type: CaptureType, url: string, startedOn: string | null): string | null {
  try {
    const fromUrl = type === 'timedtext' ? new URL(url, location.origin).searchParams.get('v') : null;
    return fromUrl ?? startedOn;
  } catch {
    return startedOn;
  }
}

function classify(url: string): CaptureType | null {
  if (url.includes('/api/timedtext')) return 'timedtext';
  if (url.includes('/youtubei/v1/get_transcript')) return 'transcript-panel';
  return null;
}

function emit(type: CaptureType, url: string, body: string, startedOn: string | null): void {
  const videoId = captureVideoId(type, url, startedOn);
  const msg = (
    type === 'transcript-panel'
      ? { [PAGE_TAG]: true, type, url, body, videoId: startedOn }
      : { [PAGE_TAG]: true, type, url, body }
  ) as PageToContent;
  buffered.push(msg, videoId);
  window.postMessage(msg, location.origin);
}

// --- XMLHttpRequest (the web player uses XHR for timedtext) ---
const xhrUrl = new WeakMap<XMLHttpRequest, string>();
const origOpen = XMLHttpRequest.prototype.open;
const origSend = XMLHttpRequest.prototype.send;

XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args: unknown[]) {
  try {
    xhrUrl.set(this, String(args[1]));
  } catch {
    /* ignore */
  }
  return (origOpen as (...a: unknown[]) => void).apply(this, args);
} as typeof XMLHttpRequest.prototype.open;

XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
  const url = xhrUrl.get(this);
  const type = url ? classify(url) : null;
  if (url && type) {
    const startedOn = pageVideoId();
    this.addEventListener('load', () => {
      try {
        let text = '';
        if (this.responseType === '' || this.responseType === 'text') text = this.responseText;
        else if (this.responseType === 'json') text = JSON.stringify(this.response);
        emit(type, url, text, startedOn);
      } catch {
        /* never break the player */
      }
    });
  }
  return origSend.call(this, body);
};

// --- fetch (get_transcript and possibly future player versions) ---
const origFetch = window.fetch;
window.fetch = async function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
  const startedOn = pageVideoId();
  const response = await origFetch.call(this ?? window, input, init);
  try {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const type = classify(url);
    if (type) {
      response
        .clone()
        .text()
        .then((text) => emit(type, url, text, startedOn))
        .catch(() => undefined);
    }
  } catch {
    /* never break the page */
  }
  return response;
};

interface YtPlayer {
  getVideoData?: () => { video_id?: string; isLive?: boolean } | undefined;
  getPlayerResponse?: () => { videoDetails?: { isLive?: boolean } } | undefined;
}

/** Ask YouTube's player API (MAIN world only) which video it has loaded and whether it's live. */
function playerInfo(): PageToContent {
  let videoId: string | null = null;
  let isLive = false;
  try {
    const p = document.getElementById('movie_player') as unknown as YtPlayer | null;
    const data = p?.getVideoData?.();
    videoId = data?.video_id || null;
    isLive = Boolean(data?.isLive || p?.getPlayerResponse?.()?.videoDetails?.isLive);
  } catch {
    /* player API missing or changed: report unknown */
  }
  return { [PAGE_TAG]: true, type: 'player-info', videoId, isLive };
}

window.addEventListener('message', (ev: MessageEvent<ContentToPage>) => {
  if (ev.source !== window || !ev.data || ev.data[PAGE_TAG] !== true) return;
  // The content script may load (or reload) after captures happened; let it ask for a replay.
  if (ev.data.type === 'replay') for (const msg of buffered.all()) window.postMessage(msg, location.origin);
  else if (ev.data.type === 'player-info?') window.postMessage(playerInfo(), location.origin);
});
