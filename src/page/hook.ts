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

type CaptureType = PageToContent['type'];

const MAX_BUFFERED = 8;
const buffered: PageToContent[] = [];

function classify(url: string): CaptureType | null {
  if (url.includes('/api/timedtext')) return 'timedtext';
  if (url.includes('/youtubei/v1/get_transcript')) return 'transcript-panel';
  return null;
}

function emit(type: CaptureType, url: string, body: string): void {
  const msg = { [PAGE_TAG]: true, type, url, body } as PageToContent;
  buffered.push(msg);
  if (buffered.length > MAX_BUFFERED) buffered.shift();
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
    this.addEventListener('load', () => {
      try {
        let text = '';
        if (this.responseType === '' || this.responseType === 'text') text = this.responseText;
        else if (this.responseType === 'json') text = JSON.stringify(this.response);
        emit(type, url, text);
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
  const response = await origFetch.call(this ?? window, input, init);
  try {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const type = classify(url);
    if (type) {
      response
        .clone()
        .text()
        .then((text) => emit(type, url, text))
        .catch(() => undefined);
    }
  } catch {
    /* never break the page */
  }
  return response;
};

// The content script may load (or reload) after captures happened; let it ask for a replay.
window.addEventListener('message', (ev: MessageEvent<ContentToPage>) => {
  if (ev.source !== window || !ev.data || ev.data[PAGE_TAG] !== true || ev.data.type !== 'replay') return;
  for (const msg of buffered) window.postMessage(msg, location.origin);
});
