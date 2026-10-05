import type { DecisionLogEntry, Feedback } from './types';

export const LOG_KEY = 'autospeed.log';
/** Full decision log (developer opt-in): about 1 KB per entry. */
export const MAX_DECISION_ENTRIES = 1000;
/** Feedback-only log (default): small entries, enough for many viewing sessions. */
export const MAX_FEEDBACK_ENTRIES = 500;

// Serialize read-modify-write cycles within this context. Concurrent tabs can still race;
// acceptable for a single-user prototype.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => undefined);
  return next;
}

export async function readLog(): Promise<DecisionLogEntry[]> {
  const got = await chrome.storage.local.get(LOG_KEY);
  return (got[LOG_KEY] as DecisionLogEntry[] | undefined) ?? [];
}

/** Append an entry, keeping at most `maxEntries` (oldest dropped first). */
export function appendDecision(entry: DecisionLogEntry, maxEntries = MAX_DECISION_ENTRIES): Promise<void> {
  return serial(async () => {
    const log = await readLog();
    log.push(entry);
    if (log.length > maxEntries) log.splice(0, log.length - maxEntries);
    await chrome.storage.local.set({ [LOG_KEY]: log });
  });
}

/**
 * The default, privacy-light record of a feedback click: the decision's numbers (speeds, speech
 * features, AI score) without transcript text or the model's description of it.
 */
export function feedbackOnlyEntry(decision: DecisionLogEntry, feedback: Feedback, now: number): DecisionLogEntry {
  return {
    ...decision,
    id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
    chunk: '',
    aiLabel: null,
    feedback,
    feedbackAt: now,
    kind: 'feedback',
  };
}

export function attachFeedback(id: string, feedback: Feedback): Promise<boolean> {
  return serial(async () => {
    const log = await readLog();
    const entry = log.find((e) => e.id === id);
    if (!entry) return false;
    entry.feedback = feedback;
    entry.feedbackAt = Date.now();
    await chrome.storage.local.set({ [LOG_KEY]: log });
    return true;
  });
}

export function clearLog(): Promise<void> {
  return serial(() => chrome.storage.local.remove(LOG_KEY));
}
