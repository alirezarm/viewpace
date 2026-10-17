/**
 * Goal Mode: viewing goals remembered across reloads (chrome.storage.local: local to this browser
 * profile, never sent anywhere, removed with the extension or its storage).
 *
 *  - Per video: the goal last started on that video. Shown again on that video, ready to Resume;
 *    it never starts Goal Mode by itself. Stop keeps it.
 *  - Last goal: the most recently started goal, offered (never applied) on other videos.
 *
 * Only goal text is kept. Analysis results are not stored: Resume analyses the video again.
 * Bounded: the MAX_VIDEOS most recently used videos (by last start); older entries are dropped.
 */
export const MAX_VIDEOS = 50;
const KEY = 'autospeed.goals';

export interface SavedGoal {
  goal: string;
  at: number; // epoch ms, when it was last started (recency for eviction)
}

export interface GoalStore {
  byVideo: Record<string, SavedGoal>;
  last: SavedGoal | null;
}

export const EMPTY_GOALS: GoalStore = { byVideo: {}, last: null };

// ---------- pure updates (tested without chrome.storage) ----------

/** Remember `goal` (started now) for `videoId` and as the last goal, keeping only the most recent MAX_VIDEOS videos. */
export function withGoal(store: GoalStore, videoId: string, goal: string, at: number, max = MAX_VIDEOS): GoalStore {
  const entry = { goal, at };
  const byVideo = { ...store.byVideo, [videoId]: entry };
  const keep = Object.entries(byVideo)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, max);
  return { byVideo: Object.fromEntries(keep), last: entry };
}

/** This video's own saved goal (offered with Resume; never started by itself). */
export function savedGoalFor(store: GoalStore, videoId: string | null): string | null {
  return videoId ? (store.byVideo[videoId]?.goal ?? null) : null;
}

/** The last goal used anywhere, offered (never applied) on a video without its own; nothing if it's already shown. */
export function suggestionFor(store: GoalStore, videoId: string | null, current: string | null): string | null {
  if (savedGoalFor(store, videoId)) return null;
  const last = store.last?.goal ?? null;
  return last && last !== current ? last : null;
}

function sanitize(raw: unknown): GoalStore {
  const s = raw as Partial<GoalStore> | undefined;
  const byVideo: Record<string, SavedGoal> = {};
  for (const [id, v] of Object.entries(s?.byVideo ?? {})) {
    if (v && typeof v.goal === 'string' && typeof v.at === 'number') byVideo[id] = { goal: v.goal, at: v.at };
  }
  const last = s?.last && typeof s.last.goal === 'string' && typeof s.last.at === 'number' ? { goal: s.last.goal, at: s.last.at } : null;
  return { byVideo, last };
}

// ---------- storage ----------

let chain: Promise<unknown> = Promise.resolve();
/** Read-modify-write one at a time, so two quick updates can't overwrite each other. */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

export async function loadGoals(): Promise<GoalStore> {
  const got = await chrome.storage.local.get(KEY);
  return sanitize(got[KEY]);
}

function update(fn: (s: GoalStore) => GoalStore): Promise<GoalStore> {
  return serial(async () => {
    const next = fn(await loadGoals());
    await chrome.storage.local.set({ [KEY]: next });
    return next;
  });
}

export const rememberGoal = (videoId: string, goal: string) => update((s) => withGoal(s, videoId, goal, Date.now()));

/** Remembered goals changed (in any tab). */
export function onGoalsChanged(cb: (s: GoalStore) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[KEY]) cb(sanitize(changes[KEY].newValue));
  });
}
