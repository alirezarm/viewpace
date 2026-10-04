import type { DecisionLogEntry, Feedback } from './types';

export const LOG_KEY = 'autospeed.log';
const MAX_ENTRIES = 5000;

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

export function appendDecision(entry: DecisionLogEntry): Promise<void> {
  return serial(async () => {
    const log = await readLog();
    log.push(entry);
    if (log.length > MAX_ENTRIES) log.splice(0, log.length - MAX_ENTRIES);
    await chrome.storage.local.set({ [LOG_KEY]: log });
  });
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
