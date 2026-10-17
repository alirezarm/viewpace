import { describe, expect, it } from 'vitest';
import { PROFILES } from '../src/content/controller';
import { GoalCoordinator } from '../src/content/goal/goal-coordinator';
import { GoalController, type GoalAnalyzer } from '../src/content/goal/goal-session';
import { EMPTY_GOALS, withGoal, withStopped, type GoalStore } from '../src/shared/goal-store';
import { parseBlockRating } from '../src/shared/goal-prompt';
import type { TimedWord } from '../src/shared/types';

const words: TimedWord[] = [];
for (let t = 1, i = 0; t < 600; t += 0.4, i++) {
  words.push({ t, w: `w${i}` });
  if (i % 120 === 119) t += 3;
}
const flush = async () => {
  for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0));
};

/** The page: which video is open, and remembered goals in an in-memory "chrome.storage". */
function page(initial: GoalStore = EMPTY_GOALS, opts: { availableGate?: Promise<void> } = {}) {
  let stored = initial;
  const env = { video: 'A' as string | null, started: [] as string[], rated: [] as string[] };
  const analyzer: GoalAnalyzer = {
    available: async () => {
      if (opts.availableGate) await opts.availableGate;
      return true;
    },
    breakdownGoal: async () => ['a', 'b', 'c'],
    rateBlock: async (goal) => {
      env.rated.push(goal);
      return parseBlockRating(JSON.stringify({ topic: 't', relevance: 8, attention: 3, reason: 'r' }));
    },
    groupSections: async () => null,
  };
  const controller = new GoalController();
  const coord = new GoalCoordinator({
    controller,
    storage: {
      load: async () => stored,
      remember: async (id, goal) => (stored = withGoal(stored, id, goal, Date.now())),
      stop: async (id) => (stored = withStopped(stored, id)),
    },
    // What main.ts does: everything GoalController.start needs, for the video that's open now.
    prepare: (id, goal) => {
      if (env.video !== id) return { error: 'Open a YouTube video first.' };
      if (!goal) return { error: 'Tell ViewPace what you want from this video.' };
      env.started.push(goal);
      return { videoId: id, goal, words, transcriptEnd: 600, analyzer, isCurrent: () => env.video === id, playhead: () => 0 };
    },
  });
  /** A YouTube SPA navigation, as main.ts handles it. */
  const navigate = (id: string | null) => {
    env.video = id;
    controller.onVideoChange(id);
    coord.onVideoChange(id);
  };
  return { coord, controller, env, navigate, stored: () => stored };
}

describe('viewing goal on the page', () => {
  it('offers a one-line goal prompt when there is no goal, and nothing where Goal Mode cannot run', async () => {
    const { coord } = page();
    await coord.init();
    expect(coord.card('A', true)).toEqual({ mode: 'chip' });
    expect(coord.card('A', false)).toEqual({ mode: 'hidden' });
  });

  it('opens the input from the prompt, with the previous goal offered but not applied', async () => {
    const { coord, controller } = page(withGoal(EMPTY_GOALS, 'Z', 'Understand how LLMs are trained', 1));
    await coord.init();
    coord.setEditing(true);
    expect(coord.card('A', true)).toEqual({ mode: 'entry', value: '', suggestion: 'Understand how LLMs are trained', canStop: false, message: null });
    expect(controller.session).toBeNull(); // nothing started
  });

  it('Start runs the existing Goal Mode pipeline, then collapses to the goal', async () => {
    const { coord, controller, env, stored } = page();
    await coord.init();
    coord.setEditing(true);
    const status = await coord.start('A', '  Understand how LLMs are trained  ');
    expect(status).toMatchObject({ phase: 'mapping', goal: 'Understand how LLMs are trained' });
    expect(controller.session).toMatchObject({ videoId: 'A', goal: 'Understand how LLMs are trained' });
    expect(coord.card('A', true)).toEqual({ mode: 'active', goal: 'Understand how LLMs are trained' });
    await flush();
    expect(env.rated.length).toBeGreaterThan(0); // blocks are being rated for that goal
    expect(stored().byVideo.A).toMatchObject({ goal: 'Understand how LLMs are trained', active: true });
  });

  it('edit reopens the input with the current goal; a new goal restarts analysis from scratch', async () => {
    const { coord, controller, stored, env } = page();
    await coord.init();
    await coord.start('A', 'first goal');
    await flush();
    const first = controller.session!;
    const ratedBefore = env.rated.length;
    coord.setEditing(true);
    expect(coord.card('A', true)).toEqual({ mode: 'entry', value: 'first goal', suggestion: null, canStop: true, message: null });
    await coord.start('A', 'second goal');
    expect(controller.session).not.toBe(first);
    expect(controller.session!.goal).toBe('second goal');
    expect(controller.session!.map).not.toBe(first.map); // a fresh map
    await flush();
    expect(env.rated.slice(ratedBefore).every((g) => g === 'second goal')).toBe(true); // re-analysed for the new goal only
    expect(first.phase).not.toBe('mapping'); // the old one was cancelled or finished; it can't write here
    expect(stored().byVideo.A).toMatchObject({ goal: 'second goal', active: true });
    expect(coord.card('A', true)).toEqual({ mode: 'active', goal: 'second goal' });
  });

  it('collapsing the editor (✕, Cancel, Escape) keeps the running goal and its saved entry untouched', async () => {
    const { coord, controller, stored } = page();
    await coord.init();
    await coord.start('A', 'the goal');
    const session = controller.session!;
    const saved = stored().byVideo.A;
    coord.setEditing(true);
    expect(coord.card('A', true)).toMatchObject({ mode: 'entry', value: 'the goal' });
    coord.setEditing(false); // what ✕, Cancel and Escape do
    expect(coord.card('A', true)).toEqual({ mode: 'active', goal: 'the goal' });
    expect(controller.session).toBe(session); // not stopped, not restarted
    expect(session.phase).toBe('mapping');
    expect(stored().byVideo.A).toEqual(saved);
  });

  it('keeps the input open with the reason when a start is refused', async () => {
    const { coord, controller } = page();
    await coord.init();
    coord.setEditing(true);
    expect(await coord.start('A', '   ')).toEqual({ error: 'Tell ViewPace what you want from this video.' });
    expect(controller.session).toBeNull();
    expect(coord.card('A', true)).toMatchObject({ mode: 'entry', message: 'Tell ViewPace what you want from this video.' });
  });

  it('restores a video\'s goal after a reload, once its captions and the AI are ready', async () => {
    const before = page();
    await before.coord.init();
    await before.coord.start('A', 'Understand how LLMs are trained');
    // Reload: a fresh content script, same storage.
    const after = page(before.stored());
    await after.coord.init();
    expect(after.coord.maybeRestore({ videoId: 'A', ready: false })).toBe(false); // waits for captions/AI
    expect(after.coord.maybeRestore({ videoId: 'A', ready: true })).toBe(true);
    await flush();
    expect(after.controller.session).toMatchObject({ videoId: 'A', goal: 'Understand how LLMs are trained' });
    expect(after.coord.card('A', true)).toEqual({ mode: 'active', goal: 'Understand how LLMs are trained' });
    expect(after.coord.maybeRestore({ videoId: 'A', ready: true })).toBe(false); // once per visit
  });

  it('never applies a goal to another video; there it is only a suggestion', async () => {
    const { coord, controller, navigate } = page();
    await coord.init();
    await coord.start('A', 'goal for A');
    navigate('B');
    expect(controller.session).toBeNull(); // A's session went with A
    expect(coord.maybeRestore({ videoId: 'B', ready: true })).toBe(false);
    expect(coord.card('B', true)).toEqual({ mode: 'chip' });
    coord.setEditing(true);
    expect(coord.card('B', true)).toMatchObject({ mode: 'entry', value: '', suggestion: 'goal for A' });
    // Reusing it is an explicit Start.
    await coord.start('B', 'goal for A');
    expect(controller.session).toMatchObject({ videoId: 'B', goal: 'goal for A' });
  });

  it('follows SPA navigation: back on a video, its own goal comes back', async () => {
    const { coord, controller, navigate } = page();
    await coord.init();
    await coord.start('A', 'goal for A');
    navigate('B');
    await coord.start('B', 'goal for B');
    navigate('A');
    expect(coord.maybeRestore({ videoId: 'A', ready: true })).toBe(true);
    await flush();
    expect(controller.session).toMatchObject({ videoId: 'A', goal: 'goal for A' });
    navigate('B');
    expect(coord.maybeRestore({ videoId: 'B', ready: true })).toBe(true);
    await flush();
    expect(controller.session).toMatchObject({ videoId: 'B', goal: 'goal for B' });
  });

  it('Stop ends the session, keeps the goal for that video as a suggestion, and does not restore it', async () => {
    const { coord, controller, stored, navigate } = page();
    await coord.init();
    await coord.start('A', 'goal for A');
    await coord.stop('A');
    expect(controller.session).toBeNull();
    expect(stored().byVideo.A).toMatchObject({ goal: 'goal for A', active: false });
    expect(coord.card('A', true)).toEqual({ mode: 'chip' });
    navigate('B');
    navigate('A');
    expect(coord.maybeRestore({ videoId: 'A', ready: true })).toBe(false);
    coord.setEditing(true);
    expect(coord.card('A', true)).toMatchObject({ suggestion: 'goal for A' });
  });

  it('the popup and the page share one state: either can start, edit or stop', async () => {
    const { coord } = page();
    await coord.init();
    // Popup: goal:start goes to coord.start; the page's card shows it.
    await coord.start('A', 'from the popup');
    expect(coord.card('A', true)).toEqual({ mode: 'active', goal: 'from the popup' });
    // Page: edit and restart; the popup's goal:status shows it.
    await coord.start('A', 'edited on the page');
    expect(coord.status('A')).toMatchObject({ goal: 'edited on the page' });
    // Popup: stop; the page's card goes back to the prompt.
    await coord.stop('A');
    expect(coord.status('A')).toBeNull();
    expect(coord.card('A', true)).toEqual({ mode: 'chip' });
  });

  it('a restore that finishes after navigating away neither runs nor gets remembered for the new video', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { coord, controller, navigate, stored, env } = page(withGoal(EMPTY_GOALS, 'A', 'goal for A', 1), { availableGate: gate });
    await coord.init();
    expect(coord.maybeRestore({ videoId: 'A', ready: true })).toBe(true); // waiting on the AI check
    navigate('B');
    release();
    await flush();
    expect(controller.session).toBeNull();
    expect(stored().byVideo.B).toBeUndefined();
    expect(env.rated).toEqual([]);
    expect(coord.card('B', true)).toEqual({ mode: 'chip' });
  });

  it('a restore that fails does not loop; the next visit may try again', async () => {
    const { coord, env, navigate } = page(withGoal(EMPTY_GOALS, 'A', 'goal for A', 1));
    await coord.init();
    env.video = 'elsewhere'; // prepare refuses (e.g. the video element isn't there yet)
    expect(coord.maybeRestore({ videoId: 'A', ready: true })).toBe(true);
    await flush();
    expect(coord.maybeRestore({ videoId: 'A', ready: true })).toBe(false); // not again on this visit
    navigate('B');
    navigate('A');
    expect(coord.maybeRestore({ videoId: 'A', ready: true })).toBe(true);
  });

  it('pacing is unchanged by restoring', async () => {
    const before = page();
    await before.coord.init();
    await before.coord.start('A', 'goal');
    await flush();
    const after = page(before.stored());
    await after.coord.init();
    after.coord.maybeRestore({ videoId: 'A', ready: true });
    await flush();
    expect(after.controller.decide('A', 100, PROFILES.normal)).toEqual(before.controller.decide('A', 100, PROFILES.normal));
  });
});
