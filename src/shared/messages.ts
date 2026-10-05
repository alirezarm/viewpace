import type { ChunkContext } from './complexity-prompt';
import type { AiAvailability, ComplexityResult } from './types';

// --- content script / popup <-> background service worker (chrome.runtime messaging) ---

export type AiRequest =
  | { kind: 'ai:status' }
  | { kind: 'ai:score'; text: string; context?: ChunkContext };

export type AiResponse =
  | { ok: true; status: AiAvailability; detail?: string }
  | { ok: true; result: ComplexityResult }
  | { ok: false; error: string; status?: AiAvailability };

// --- popup <-> content script in the active tab (chrome.tabs.sendMessage) ---

export type TabState = 'active' | 'off' | 'paused-by-user' | 'ad' | 'unsupported' | 'idle';

export interface TabStatus {
  /** A YouTube watch page with a video element. */
  onVideo: boolean;
  state: TabState;
  rate: number | null;
}

export type TabRequest = { kind: 'tab:status' };

// --- MAIN-world hook <-> isolated content script (window.postMessage) ---

export const PAGE_TAG = '__autospeed';

export type PageToContent =
  | { [PAGE_TAG]: true; type: 'timedtext'; url: string; body: string }
  | { [PAGE_TAG]: true; type: 'transcript-panel'; url: string; body: string };

export type ContentToPage = { [PAGE_TAG]: true; type: 'replay' };
