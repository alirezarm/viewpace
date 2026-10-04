/**
 * Offscreen document: hosts the Gemini Nano session. The Prompt API is not exposed to the
 * extension service worker (a worker), and running it here keeps it on the extension origin
 * instead of youtube.com.
 */
import type { AiResponse, OffscreenEnvelope } from '../shared/messages';
import { NanoComplexityEngine, nanoAvailability } from '../shared/nano';

const engine = new NanoComplexityEngine();

chrome.runtime.onMessage.addListener((msg: OffscreenEnvelope, _sender, sendResponse: (r: AiResponse) => void) => {
  if (msg?.target !== 'offscreen') return false;
  const { request } = msg;

  (async (): Promise<AiResponse> => {
    if (request.kind === 'ai:status') return { ok: true, status: await nanoAvailability() };
    const status = await nanoAvailability();
    if (status !== 'available') return { ok: false, status, error: `Gemini Nano is ${status}` };
    try {
      return { ok: true, result: await engine.score(request.text, request.context) };
    } catch (e) {
      return { ok: false, status, error: e instanceof Error ? e.message : String(e) };
    }
  })().then(sendResponse);
  return true; // async response
});
