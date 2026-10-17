/**
 * Goal Mode: viewing goals remembered across reloads (chrome.storage.local: local to this browser
 * profile, never sent anywhere, removed with the extension or its storage).
 *
 *  - Per video: the goal last started on that video. While `active`, it is started again when the
 *    viewer comes back to that video; after Stop it stays, inactive, as a suggestion there.
 *  - Last goal: the most recently started goal, offered (never applied) on other videos.
 *
 * Only goal text is kept. Analysis results are not stored: a restored goal is analysed again.
 * Bounded: the MAX_VIDEOS most recently used videos (by last start); older entries are dropped.
 */
export const MAX_VIDEOS = 50;
const KEY = 'autospeed.goals';

export interface SavedGoal {
  goal: string;
  at: number; // epoch ms, when it was last started (recency for eviction)
  /** Goal Mode was left running with this goal (false after Stop): restore it on return. */
  active: boolean;
}

export interface GoalStore {
  byVideo: Record<string, SavedGoal>;
  last: SavedGoal | null;
}

export const EMPTY_GOALS: GoalStore = { byVideo: {}, last: null };

// ---------- pure updates (tested without chrome.storage) ----------

/** Remember `goal` (started now) for `videoId` and as the last goal, keeping only the most recent MAX_VIDEOS videos. */
export function withGoal(store: GoalStore, videoId: string, goal: string, at: number, max = MAX_VIDEOS): GoalStore {
  const entry = { goal, at, active: true };
  const byVideo = { ...store.byVideo, [videoId]: entry };
  const keep = Object.entries(byVideo)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, max);
  return { byVideo: Object.fromEntries(keep), last: entry };
}

/** Stop on `videoId`: keep its goal as text, but don't start it again on return. */
export function withStopped(store: GoalStore, videoId: string): GoalStore {
  const e = store.byVideo[videoId];
  if (!e || !e.active) return store;
  return { ...store, byVideo: { ...store.byVideo, [videoId]: { ...e, active: false } } };
}

/** The goal to start again automatically: only one left running on this very video. */
export function savedGoalFor(store: GoalStore, videoId: string | null): string | null {
  const e = videoId ? store.byVideo[videoId] : undefined;
  return e?.active ? e.goal : null;
}

/**
 * The goal to offer (never apply) when typing a goal: this video's own stopped goal if it has one,
 * otherwise the last goal used anywhere; nothing if it's already the goal shown.
 */
export function suggestionFor(store: GoalStore, videoId: string | null, current: string | null): string | null {
  const own = videoId ? store.byVideo[videoId]?.goal : undefined;
  const s = own ?? store.last?.goal ?? null;
  return s && s !== current ? s : null;
}

function sanitize(raw: unknown): GoalStore {
  const s = raw as Partial<GoalStore> | undefined;
  const byVideo: Record<string, SavedGoal> = {};
  for (const [id, v] of Object.entries(s?.byVideo ?? {})) {
    if (v && typeof v.goal === 'string' && typeof v.at === 'number') byVideo[id] = { goal: v.goal, at: v.at, active: v.active === true };
  }
  const last = s?.last && typeof s.last.goal === 'string' && typeof s.last.at === 'number' ? { goal: s.last.goal, at: s.last.at, active: false } : null;
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
export const stopGoal = (videoId: string) => update((s) => withStopped(s, videoId));

/** Remembered goals changed (in any tab). */
export function onGoalsChanged(cb: (s: GoalStore) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[KEY]) cb(sanitize(changes[KEY].newValue));
  });
}
