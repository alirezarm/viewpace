import { describe, expect, it } from 'vitest';
import { PROFILES } from '../src/content/controller';
import { GoalCoordinator, startFailure } from '../src/content/goal/goal-coordinator';
import { GoalController, type GoalAnalyzer } from '../src/content/goal/goal-session';
import { EMPTY_GOALS, withGoal, type GoalStore } from '../src/shared/goal-store';
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

/** The page: which video is open, remembered goals in an in-memory "chrome.storage", and every Nano call. */
function page(initial: GoalStore = EMPTY_GOALS, opts: { availableGate?: Promise<void> } = {}) {
  let stored = initial;
  const env = { video: 'A' as string | null, nano: [] as string[], rated: [] as string[] };
  const analyzer: GoalAnalyzer = {
    available: async () => {
      if (opts.availableGate) await opts.availableGate;
      return true;
    },
    breakdownGoal: async (goal) => {
      env.nano.push(`breakdown ${goal}`);
      return ['a', 'b', 'c'];
    },
    rateBlock: async (goal) => {
      env.nano.push(`block ${goal}`);
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
    },
    // What main.ts does: everything GoalController.start needs, for the video that's open now.
    prepare: (id, goal) => {
      if (env.video !== id) return { error: 'Open a YouTube video first.' };
      if (!goal) return { error: 'Tell ViewPace what you want from this video.' };
      return { videoId: id, goal, words, transcriptEnd: 600, analyzer, isCurrent: () => env.video === id, playhead: () => 0 };
    },
  });
  /** A YouTube SPA navigation, as main.ts handles it. */
  const navigate = (id: string | null) => {
    env.video = id;
    controller.onVideoChange(id);
    coord.onVideoChange();
  };
  return { coord, controller, env, navigate, stored: () => stored };
}

describe('viewing goal: no goal', () => {
  it('offers a one-line goal prompt, and nothing where Goal Mode cannot run', async () => {
    const { coord } = page();
    await coord.init();
    expect(coord.card('A', true)).toEqual({ mode: 'chip' });
    expect(coord.card('A', false)).toEqual({ mode: 'hidden' });
  });

  it('opens the input, with the previous goal offered but not applied', async () => {
    const { coord, controller } = page(withGoal(EMPTY_GOALS, 'Z', 'Understand how LLMs are trained', 1));
    await coord.init();
    coord.setEditing(true);
    expect(coord.card('A', true)).toEqual({ mode: 'entry', value: '', suggestion: 'Understand how LLMs are trained', canStop: false, message: null });
    expect(controller.session).toBeNull();
  });

  it('Start runs the existing Goal Mode pipeline, saves the goal, and collapses to it', async () => {
    const { coord, controller, env, stored } = page();
    await coord.init();
    coord.setEditing(true);
    expect(await coord.start('A', '  Understand how LLMs are trained  ')).toMatchObject({ phase: 'mapping', goal: 'Understand how LLMs are trained' });
    expect(controller.session).toMatchObject({ videoId: 'A', goal: 'Understand how LLMs are trained' });
    expect(coord.card('A', true)).toEqual({ mode: 'active', goal: 'Understand how LLMs are trained' });
    await flush();
    expect(env.rated.length).toBeGreaterThan(0);
    expect(stored().byVideo.A).toMatchObject({ goal: 'Understand how LLMs are trained' });
  });

  it('keeps the input open with the reason when a start is refused', async () => {
    const { coord, controller } = page();
    await coord.init();
    coord.setEditing(true);
    expect(await coord.start('A', '   ')).toEqual({ error: 'Tell ViewPace what you want from this video.' });
    expect(controller.session).toBeNull();
    expect(coord.card('A', true)).toMatchObject({ mode: 'entry', message: 'Tell ViewPace what you want from this video.' });
  });
});

describe('viewing goal: saved but not active', () => {
  it('after a reload the saved goal is shown with Resume, and no analysis runs', async () => {
    const before = page();
    await before.coord.init();
    await before.coord.start('A', 'Understand how LLMs are trained');
    // Reload: a fresh content script, same storage. Let plenty of ticks go by.
    const after = page(before.stored());
    await after.coord.init();
    await flush();
    expect(after.controller.session).toBeNull();
    expect(after.env.nano).toEqual([]); // no Nano call at all
    expect(after.coord.card('A', true)).toEqual({ mode: 'saved', goal: 'Understand how LLMs are trained', message: null });
  });

  it('Resume starts mapping with the saved goal', async () => {
    const { coord, controller, env } = page(withGoal(EMPTY_GOALS, 'A', 'saved goal', 1));
    await coord.init();
    expect(await coord.resume('A')).toMatchObject({ phase: 'mapping', goal: 'saved goal' });
    await flush();
    expect(controller.session).toMatchObject({ videoId: 'A', goal: 'saved goal' });
    expect(env.nano[0]).toBe('breakdown saved goal');
    expect(coord.card('A', true)).toEqual({ mode: 'active', goal: 'saved goal' });
  });

  it('Resume with nothing saved does nothing', async () => {
    const { coord, controller } = page();
    await coord.init();
    expect(await coord.resume('A')).toEqual({ error: 'There is no saved goal for this video.' });
    expect(controller.session).toBeNull();
  });

  it('editing a saved goal starts with it in the input; closing goes back to Resume', async () => {
    const { coord } = page(withGoal(EMPTY_GOALS, 'A', 'saved goal', 1));
    await coord.init();
    coord.setEditing(true);
    expect(coord.card('A', true)).toEqual({ mode: 'entry', value: 'saved goal', suggestion: null, canStop: false, message: null });
    coord.setEditing(false);
    expect(coord.card('A', true)).toEqual({ mode: 'saved', goal: 'saved goal', message: null });
  });
});

describe('viewing goal: Resume that cannot start', () => {
  /** A page whose captions aren't captured yet (prepare can't give the words), until `captions()` is called. */
  function noCaptionsYet() {
    const p = page(withGoal(EMPTY_GOALS, 'A', 'saved goal', 1));
    let ready = false;
    const prepare = (p.coord as unknown as { deps: { prepare: (id: string, g: string) => unknown } }).deps.prepare;
    (p.coord as unknown as { deps: { prepare: unknown } }).deps.prepare = (id: string, g: string) => {
      const opts = prepare(id, g) as Record<string, unknown>;
      return 'error' in opts || ready ? opts : { ...opts, words: null };
    };
    return { ...p, captions: () => (ready = true) };
  }

  it('says why in the card, keeps the saved goal, and does not pretend Goal Mode is on', async () => {
    const { coord, controller, stored } = noCaptionsYet();
    await coord.init();
    const saved = stored().byVideo.A;
    const r = await coord.resume('A');
    expect(r).toMatchObject({ phase: 'no-transcript' });
    expect(controller.session).toBeNull();
    expect(coord.card('A', true)).toEqual({ mode: 'saved', goal: 'saved goal', message: "Couldn't read this video's captions. Play it for a moment, then try again." });
    expect(stored().byVideo.A).toEqual(saved);
  });

  it('a retry that works clears the message and starts mapping', async () => {
    const { coord, controller, captions } = noCaptionsYet();
    await coord.init();
    await coord.resume('A');
    captions();
    expect(await coord.resume('A')).toMatchObject({ phase: 'mapping', goal: 'saved goal' });
    expect(controller.session).toMatchObject({ goal: 'saved goal' });
    expect(coord.card('A', true)).toEqual({ mode: 'active', goal: 'saved goal' });
    coord.stop();
    expect(coord.card('A', true)).toEqual({ mode: 'saved', goal: 'saved goal', message: null }); // no stale message
  });

  it('the message goes away on editing or another video', async () => {
    const { coord, navigate } = noCaptionsYet();
    await coord.init();
    await coord.resume('A');
    coord.setEditing(true);
    coord.setEditing(false);
    expect(coord.card('A', true)).toMatchObject({ message: null });
    await coord.resume('A');
    navigate('B');
    navigate('A');
    expect(coord.card('A', true)).toMatchObject({ message: null });
  });

  it('turns failures into plain words (no internals)', () => {
    expect(startFailure({ phase: 'no-ai' } as never)).toBe("Chrome's on-device AI isn't available right now. Try again later.");
    expect(startFailure(null)).toBe("Couldn't start Goal Mode. Try again.");
  });
});

describe('viewing goal: active', () => {
  it('Stop ends Goal Mode, keeps the saved goal, and goes back to Resume', async () => {
    const { coord, controller, stored, env } = page();
    await coord.init();
    await coord.start('A', 'goal for A');
    await flush();
    const saved = stored().byVideo.A;
    coord.stop();
    expect(controller.session).toBeNull();
    expect(stored().byVideo.A).toEqual(saved); // untouched
    expect(coord.card('A', true)).toEqual({ mode: 'saved', goal: 'goal for A', message: null });
    const calls = env.nano.length;
    await flush();
    expect(env.nano.length).toBe(calls); // no more analysis
  });

  it("edit + Start saves the new goal and analyses afresh; the old goal's work cannot write to it", async () => {
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
    expect(controller.session!.map).not.toBe(first.map);
    expect(first.phase).not.toBe('mapping');
    await flush();
    expect(env.rated.slice(ratedBefore).every((g) => g === 'second goal')).toBe(true);
    expect(stored().byVideo.A).toMatchObject({ goal: 'second goal' });
    expect(coord.card('A', true)).toEqual({ mode: 'active', goal: 'second goal' });
  });

  it('collapsing the editor keeps the running goal and its saved entry untouched', async () => {
    const { coord, controller, stored } = page();
    await coord.init();
    await coord.start('A', 'the goal');
    const session = controller.session!;
    const saved = stored().byVideo.A;
    coord.setEditing(true);
    coord.setEditing(false);
    expect(coord.card('A', true)).toEqual({ mode: 'active', goal: 'the goal' });
    expect(controller.session).toBe(session);
    expect(stored().byVideo.A).toEqual(saved);
  });

  it('the popup and the page share one state: either can start, edit, stop or resume', async () => {
    const { coord } = page();
    await coord.init();
    await coord.start('A', 'from the popup'); // popup goal:start
    expect(coord.card('A', true)).toEqual({ mode: 'active', goal: 'from the popup' });
    await coord.start('A', 'edited on the page');
    expect(coord.status('A')).toMatchObject({ goal: 'edited on the page' }); // popup goal:status
    coord.stop(); // popup goal:stop
    expect(coord.status('A')).toBeNull();
    expect(coord.card('A', true)).toEqual({ mode: 'saved', goal: 'edited on the page', message: null });
    await coord.resume('A'); // page Resume
    expect(coord.status('A')).toMatchObject({ phase: 'mapping', goal: 'edited on the page' });
  });
});

describe('viewing goal across videos', () => {
  it('never activates a goal on another video; there it is only a suggestion', async () => {
    const { coord, controller, navigate, env } = page();
    await coord.init();
    await coord.start('A', 'goal for A');
    navigate('B');
    await flush();
    expect(controller.session).toBeNull();
    const calls = env.nano.length;
    expect(coord.card('B', true)).toEqual({ mode: 'chip' });
    coord.setEditing(true);
    expect(coord.card('B', true)).toMatchObject({ mode: 'entry', value: '', suggestion: 'goal for A' });
    expect(env.nano.length).toBe(calls);
    await coord.start('B', 'goal for A'); // reusing it is an explicit Start
    expect(controller.session).toMatchObject({ videoId: 'B', goal: 'goal for A' });
  });

  it('SPA navigation: each video shows its own saved goal, inactive until Resume', async () => {
    const { coord, controller, navigate, env } = page();
    await coord.init();
    await coord.start('A', 'goal for A');
    coord.setEditing(true); // an open editor doesn't follow you to the next video
    navigate('B');
    expect(coord.card('B', true)).toEqual({ mode: 'chip' });
    await coord.start('B', 'goal for B');
    navigate('A');
    await flush();
    const calls = env.nano.length;
    expect(controller.session).toBeNull();
    expect(coord.card('A', true)).toEqual({ mode: 'saved', goal: 'goal for A', message: null });
    navigate('B');
    expect(coord.card('B', true)).toEqual({ mode: 'saved', goal: 'goal for B', message: null });
    await flush();
    expect(env.nano.length).toBe(calls);
  });

  it('a start that finishes after navigating away neither runs nor gets saved', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { coord, controller, navigate, stored, env } = page(withGoal(EMPTY_GOALS, 'A', 'goal for A', 1), { availableGate: gate });
    await coord.init();
    const resumed = coord.resume('A'); // waiting on the AI check
    navigate('B');
    release();
    await resumed;
    await flush();
    expect(controller.session).toBeNull();
    expect(stored().byVideo.B).toBeUndefined();
    expect(env.rated).toEqual([]);
    expect(coord.card('B', true)).toEqual({ mode: 'chip' });
  });

  it('pacing after Resume is the same as before', async () => {
    const before = page();
    await before.coord.init();
    await before.coord.start('A', 'goal');
    await flush();
    const after = page(before.stored());
    await after.coord.init();
    await after.coord.resume('A');
    await flush();
    expect(after.controller.decide('A', 100, PROFILES.normal)).toEqual(before.controller.decide('A', 100, PROFILES.normal));
  });
});
