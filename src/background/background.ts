import type { AiRequest, AiResponse } from '../shared/messages';
import { NanoComplexityEngine, nanoAvailability } from '../shared/nano';
import { loadSettings, saveSettings } from '../shared/settings';

/**
 * Gemini Nano runs here, in the extension service worker: Chrome exposes the Prompt API to
 * extension service workers (unlike web-page workers). When Chrome stops this worker after
 * ~30 s idle, the session is lost; this module is re-evaluated on the next message and the
 * engine re-creates its session lazily on the first score request.
 */
const engine = new NanoComplexityEngine();

chrome.runtime.onMessage.addListener((msg: AiRequest, _sender, sendResponse: (r: AiResponse) => void) => {
  if (msg?.kind !== 'ai:status' && msg?.kind !== 'ai:score') return false;

  (async (): Promise<AiResponse> => {
    if (msg.kind === 'ai:status') return { ok: true, status: await nanoAvailability() };
    const status = await nanoAvailability();
    // The model download needs a user gesture, which a service worker never has: it is
    // started from the popup. Until then, report the status instead of trying to create.
    if (status !== 'available') return { ok: false, status, error: `Gemini Nano is ${status}` };
    try {
      return { ok: true, result: await engine.score(msg.text, msg.context) };
    } catch (e) {
      return { ok: false, status, error: e instanceof Error ? e.message : String(e) };
    }
  })().then(sendResponse);
  return true; // async response
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-autospeed') return;
  const s = await loadSettings();
  await saveSettings({ enabled: !s.enabled });
});
