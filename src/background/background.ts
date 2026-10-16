import type { AiRequest, AiResponse } from '../shared/messages';
import {
  BLOCK_SCHEMA,
  BREAKDOWN_SCHEMA,
  BREAKDOWN_SYSTEM_PROMPT,
  SECTION_SCHEMA,
  SECTION_SYSTEM_PROMPT,
  blockSystemPrompt,
  buildBlockPrompt,
  buildBreakdownPrompt,
  buildSectionPrompt,
  parseBlockRating,
  parseBreakdown,
  parseSections,
} from '../shared/goal-prompt';
import { NanoComplexityEngine, NanoPrompter, nanoAvailability } from '../shared/nano';
import { loadOnboarding, reconcileSmartPacing, saveOnboarding } from '../shared/onboarding';
import { loadSettings, saveSettings } from '../shared/settings';

/**
 * Gemini Nano runs here, in the extension service worker: Chrome exposes the Prompt API to
 * extension service workers (unlike web-page workers). When Chrome stops this worker after
 * ~30 s idle, the session is lost; this module is re-evaluated on the next message and the
 * engine re-creates its session lazily on the first score request.
 */
const prompter = new NanoPrompter(); // one queue: one on-device inference at a time
const engine = new NanoComplexityEngine(prompter);
const GOAL_TIMEOUT_MS = 30000;

chrome.runtime.onMessage.addListener((msg: AiRequest, _sender, sendResponse: (r: AiResponse) => void) => {
  if (msg?.kind !== 'ai:status' && msg?.kind !== 'ai:score' && msg?.kind !== 'ai:goal-block' && msg?.kind !== 'ai:goal-breakdown' && msg?.kind !== 'ai:goal-sections') {
    return false;
  }

  (async (): Promise<AiResponse> => {
    // Status checks double as the moment to switch smart pacing on once the model is ready
    // (e.g. a download that finished after the popup was closed).
    if (msg.kind === 'ai:status') return { ok: true, status: await reconcileSmartPacing() };
    const status = await nanoAvailability();
    // The model download needs a user gesture, which a service worker never has: it is
    // started from the popup. Until then, report the status instead of trying to create.
    if (status !== 'available') return { ok: false, status, error: `Gemini Nano is ${status}` };
    try {
      if (msg.kind === 'ai:goal-breakdown') {
        const raw = await prompter.prompt(BREAKDOWN_SYSTEM_PROMPT, buildBreakdownPrompt(msg.goal), BREAKDOWN_SCHEMA, GOAL_TIMEOUT_MS);
        return { ok: true, needs: parseBreakdown(raw) };
      }
      if (msg.kind === 'ai:goal-block') {
        const raw = await prompter.prompt(blockSystemPrompt(msg.needs), buildBlockPrompt(msg.goal, msg.text, msg.title, msg.needs), BLOCK_SCHEMA, GOAL_TIMEOUT_MS);
        return { ok: true, goalBlock: parseBlockRating(raw) };
      }
      if (msg.kind === 'ai:goal-sections') {
        const raw = await prompter.prompt(SECTION_SYSTEM_PROMPT, buildSectionPrompt(msg.goal, msg.parts), SECTION_SCHEMA, GOAL_TIMEOUT_MS);
        return { ok: true, sections: parseSections(raw, msg.first, msg.last) };
      }
      return { ok: true, result: await engine.score(msg.text, msg.context) };
    } catch (e) {
      return { ok: false, status, error: e instanceof Error ? e.message : String(e) };
    }
  })().then(sendResponse);
  return true; // async response
});

// First run: ViewPace already works (speech-based); the welcome page offers smart pacing.
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === chrome.runtime.OnInstalledReason.INSTALL && !(await loadOnboarding()).welcomed) {
    await saveOnboarding({ welcomed: true });
    await chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
  }
  void reconcileSmartPacing();
});

chrome.runtime.onStartup.addListener(() => void reconcileSmartPacing());

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-autospeed') return;
  const s = await loadSettings();
  await saveSettings({ enabled: !s.enabled });
});
