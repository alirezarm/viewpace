import type { AiRequest, AiResponse, OffscreenEnvelope } from '../shared/messages';
import { loadSettings, saveSettings } from '../shared/settings';

const OFFSCREEN_URL = 'offscreen.html';
let creating: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  const url = chrome.runtime.getURL(OFFSCREEN_URL);
  const existing = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [url],
  });
  if (existing.length > 0) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        // No offscreen reason covers on-device LLM inference; DOM_PARSER is the closest
        // generic one. Chrome does not enforce the reason for unpacked extensions.
        reasons: [chrome.offscreen.Reason.DOM_PARSER],
        justification: 'Run the on-device Prompt API (Gemini Nano) to score transcript complexity.',
      })
      .finally(() => (creating = null));
  }
  await creating;
}

chrome.runtime.onMessage.addListener((msg: AiRequest | OffscreenEnvelope, _sender, sendResponse: (r: AiResponse) => void) => {
  if (!msg || 'target' in msg) return false; // messages for the offscreen doc
  if (msg.kind !== 'ai:status' && msg.kind !== 'ai:score') return false;

  (async (): Promise<AiResponse> => {
    try {
      await ensureOffscreen();
      const envelope: OffscreenEnvelope = { target: 'offscreen', request: msg };
      return (await chrome.runtime.sendMessage(envelope)) as AiResponse;
    } catch (e) {
      return { ok: false, status: 'error', error: e instanceof Error ? e.message : String(e) };
    }
  })().then(sendResponse);
  return true;
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-autospeed') return;
  const s = await loadSettings();
  await saveSettings({ enabled: !s.enabled });
});
