import { describe, expect, it } from 'vitest';
import { EMPTY_GOALS, MAX_VIDEOS, savedGoalFor, suggestionFor, withGoal } from '../src/shared/goal-store';

describe('remembered viewing goals', () => {
  it('remembers a goal per video and as the last goal', () => {
    const s = withGoal(EMPTY_GOALS, 'A', 'Understand how LLMs are trained', 1);
    expect(s.byVideo.A).toEqual({ goal: 'Understand how LLMs are trained', at: 1 });
    expect(s.last).toEqual({ goal: 'Understand how LLMs are trained', at: 1 });
    expect(savedGoalFor(s, 'A')).toBe('Understand how LLMs are trained');
  });

  it('belongs to the same video only', () => {
    const s = withGoal(EMPTY_GOALS, 'A', 'goal A', 1);
    expect(savedGoalFor(s, 'B')).toBeNull();
    expect(savedGoalFor(s, null)).toBeNull();
  });

  it('a changed goal replaces the video\'s entry', () => {
    const s = withGoal(withGoal(EMPTY_GOALS, 'A', 'first', 1), 'A', 'second', 2);
    expect(Object.keys(s.byVideo)).toEqual(['A']);
    expect(s.byVideo.A).toEqual({ goal: 'second', at: 2 });
  });

  it('suggests the last goal on another video, not as that video\'s own goal', () => {
    const s = withGoal(withGoal(EMPTY_GOALS, 'A', 'goal A', 1), 'B', 'goal B', 2);
    expect(suggestionFor(s, 'C', null)).toBe('goal B');
    expect(savedGoalFor(s, 'C')).toBeNull();
    expect(suggestionFor(s, 'C', 'goal B')).toBeNull(); // already the goal shown
    expect(suggestionFor(EMPTY_GOALS, 'C', null)).toBeNull();
    expect(suggestionFor(s, 'A', null)).toBeNull(); // A has its own saved goal
  });

  it(`keeps at most ${MAX_VIDEOS} videos, dropping the least recently started`, () => {
    let s = EMPTY_GOALS;
    for (let i = 0; i < MAX_VIDEOS + 5; i++) s = withGoal(s, `v${i}`, `goal ${i}`, i);
    expect(Object.keys(s.byVideo)).toHaveLength(MAX_VIDEOS);
    expect(s.byVideo.v0).toBeUndefined(); // the five oldest are gone
    expect(s.byVideo.v4).toBeUndefined();
    expect(s.byVideo.v5).toBeDefined();
    // Starting an old video's goal again makes it recent, so it survives the next eviction.
    s = withGoal(s, 'v5', 'goal 5', 100);
    s = withGoal(s, 'new', 'goal new', 101);
    expect(s.byVideo.v5).toBeDefined();
    expect(s.byVideo.v6).toBeUndefined();
  });
});
