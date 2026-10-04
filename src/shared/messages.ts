import type { ChunkContext } from './complexity-prompt';
import type { AiAvailability, ComplexityResult } from './types';

// --- content script <-> background <-> offscreen (chrome.runtime messaging) ---

export type AiRequest =
  | { kind: 'ai:status' }
  | { kind: 'ai:score'; text: string; context?: ChunkContext };

export type AiResponse =
  | { ok: true; status: AiAvailability; detail?: string }
  | { ok: true; result: ComplexityResult }
  | { ok: false; error: string; status?: AiAvailability };

/** Background forwards AI requests to the offscreen document wrapped like this. */
export interface OffscreenEnvelope {
  target: 'offscreen';
  request: AiRequest;
}

// --- MAIN-world hook <-> isolated content script (window.postMessage) ---

export const PAGE_TAG = '__autospeed';

export type PageToContent =
  | { [PAGE_TAG]: true; type: 'timedtext'; url: string; body: string }
  | { [PAGE_TAG]: true; type: 'transcript-panel'; url: string; body: string };

export type ContentToPage = { [PAGE_TAG]: true; type: 'replay' };
