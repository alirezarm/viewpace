import type { ChunkContext } from './complexity-prompt';
import type { BlockRating, PartSummary, SectionRange } from './goal-prompt';
import type { AiAvailability, ComplexityResult } from './types';

// --- content script / popup <-> background service worker (chrome.runtime messaging) ---

export type AiRequest =
  | { kind: 'ai:status' }
  | { kind: 'ai:score'; text: string; context?: ChunkContext }
  // Goal Mode (experimental): rate one transcript block against the user's goal…
  | { kind: 'ai:goal-block'; goal: string; text: string; title?: string; context?: string }
  // …and group consecutive rated blocks into sections.
  | { kind: 'ai:goal-sections'; goal: string; parts: PartSummary[]; first: number; last: number };

export type AiResponse =
  | { ok: true; status: AiAvailability; detail?: string }
  | { ok: true; result: ComplexityResult }
  | { ok: true; goalBlock: BlockRating }
  | { ok: true; sections: SectionRange[] | null }
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

/** Goal Mode (experimental): popup → tab. Answered with the tab's GoalStatus (or an error). */
export type GoalTabRequest = { kind: 'goal:start'; goal: string } | { kind: 'goal:stop' } | { kind: 'goal:status' };

// --- MAIN-world hook <-> isolated content script (window.postMessage) ---

export const PAGE_TAG = '__autospeed';

export type PageToContent =
  | { [PAGE_TAG]: true; type: 'timedtext'; url: string; body: string }
  /** `videoId`: the page's video when the request started (the response may arrive after navigating). */
  | { [PAGE_TAG]: true; type: 'transcript-panel'; url: string; body: string; videoId: string | null }
  /** What YouTube's player reports (via its own API) about the video it has loaded. */
  | { [PAGE_TAG]: true; type: 'player-info'; videoId: string | null; isLive: boolean };

export type ContentToPage = { [PAGE_TAG]: true; type: 'replay' | 'player-info?' };
