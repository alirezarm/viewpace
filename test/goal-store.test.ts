import { describe, expect, it } from 'vitest';
import { EMPTY_GOALS, MAX_VIDEOS, savedGoalFor, suggestionFor, withGoal, withStopped } from '../src/shared/goal-store';

describe('remembered viewing goals', () => {
  it('remembers a goal per video and as the last goal', () => {
    const s = withGoal(EMPTY_GOALS, 'A', 'Understand how LLMs are trained', 1);
    expect(s.byVideo.A).toEqual({ goal: 'Understand how LLMs are trained', at: 1, active: true });
    expect(s.last).toEqual({ goal: 'Understand how LLMs are trained', at: 1, active: true });
    expect(savedGoalFor(s, 'A')).toBe('Understand how LLMs are trained');
  });

  it('restores only on the same video', () => {
    const s = withGoal(EMPTY_GOALS, 'A', 'goal A', 1);
    expect(savedGoalFor(s, 'B')).toBeNull();
    expect(savedGoalFor(s, null)).toBeNull();
  });

  it('a changed goal replaces the video\'s entry', () => {
    const s = withGoal(withGoal(EMPTY_GOALS, 'A', 'first', 1), 'A', 'second', 2);
    expect(Object.keys(s.byVideo)).toEqual(['A']);
    expect(s.byVideo.A).toEqual({ goal: 'second', at: 2, active: true });
  });

  it('Stop keeps the goal text but no longer restores it', () => {
    const s = withStopped(withGoal(EMPTY_GOALS, 'A', 'goal A', 1), 'A');
    expect(s.byVideo.A).toEqual({ goal: 'goal A', at: 1, active: false });
    expect(savedGoalFor(s, 'A')).toBeNull();
    expect(suggestionFor(s, 'A', null)).toBe('goal A'); // offered again on that video
    expect(withStopped(s, 'nope')).toBe(s);
  });

  it('suggests the last goal on another video, never as a goal to restore', () => {
    const s = withGoal(withGoal(EMPTY_GOALS, 'A', 'goal A', 1), 'B', 'goal B', 2);
    expect(suggestionFor(s, 'C', null)).toBe('goal B');
    expect(savedGoalFor(s, 'C')).toBeNull();
    expect(suggestionFor(s, 'C', 'goal B')).toBeNull(); // already the goal shown
    expect(suggestionFor(EMPTY_GOALS, 'C', null)).toBeNull();
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
