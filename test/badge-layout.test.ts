import { describe, expect, it } from 'vitest';
import { cardLayout } from '../src/content/badge';
import type { GoalCardView } from '../src/content/goal/goal-coordinator';
import type { GoalTimeline } from '../src/content/goal/goal-timeline';

const tl: GoalTimeline = { duration: 600, position: 10, progress: 0.1, mapping: true, segments: [], regions: [] };
const view = (goalCard: GoalCardView, timeline: GoalTimeline | null = null, state: 'active' | 'off' | 'paused-by-user' = 'active') => ({ goalCard, timeline, state });

describe('the one ViewPace card', () => {
  it('without a goal is just the compact speed row (plus the goal prompt where Goal Mode can run)', () => {
    expect(cardLayout(view({ mode: 'hidden' }), false)).toEqual({ goal: false, map: false, feedback: false, resume: false, wide: false });
    expect(cardLayout(view({ mode: 'chip' }), false)).toMatchObject({ goal: true, map: false, wide: true });
  });

  it('holds goal, Goal Map and the current speed together while Goal Mode runs', () => {
    expect(cardLayout(view({ mode: 'active', goal: 'g' }, tl), false)).toEqual({ goal: true, map: true, feedback: false, resume: false, wide: true });
  });

  it('shows a saved goal (with Resume) and no map until it is resumed', () => {
    expect(cardLayout(view({ mode: 'saved', goal: 'g', message: null }), false)).toMatchObject({ goal: true, map: false });
  });

  it('opens speed feedback inside the same card, and folds back when it closes', () => {
    const open = cardLayout(view({ mode: 'active', goal: 'g' }, tl), true);
    expect(open).toEqual({ goal: true, map: true, feedback: true, resume: false, wide: true });
    expect(cardLayout(view({ mode: 'hidden' }), true)).toMatchObject({ feedback: true, wide: true });
    expect(cardLayout(view({ mode: 'hidden' }), false)).toMatchObject({ feedback: false, wide: false });
  });

  it('shows "Resume ViewPace" inside the card after a manual speed change', () => {
    expect(cardLayout(view({ mode: 'hidden' }, null, 'paused-by-user'), false)).toMatchObject({ resume: true });
  });
});
