import { describe, expect, it } from 'vitest';
import { RateOwner, SETTLE_MS, TEMPORARY_MS } from '../src/content/rate-owner';

/** Owner that has taken control at `rate` from a user speed of `user`, long after any settling. */
function controlling(user = 1, rate = 1.6): RateOwner {
  const o = new RateOwner();
  o.take(rate, user);
  return o;
}
const LATER = 100_000;

describe('Never fight a speed change AutoSpeed did not make', () => {
  it('recognizes its own change', () => {
    expect(controlling().onRateChange(1.6, LATER, false)).toBe('own');
  });

  it('suspends on any other change and adopts it as the user speed', () => {
    const o = controlling();
    expect(o.onRateChange(1.25, LATER, false)).toBe('suspend');
    expect(o.suspended).toBe(true);
    expect(o.controlling).toBe(false);
    expect(o.userRate).toBe(1.25);
  });

  it('suspends even when AutoSpeed was not in control yet', () => {
    const o = new RateOwner();
    expect(o.onRateChange(1.5, LATER, false)).toBe('suspend');
  });

  it('keeps following the user while suspended and never re-applies', () => {
    const o = controlling();
    o.onRateChange(1.25, LATER, false);
    expect(o.onRateChange(1.75, LATER + 30_000, false)).toBe('ignore');
    expect(o.userRate).toBe(1.75);
  });

  it('ignores changes during ads or while AutoSpeed is off', () => {
    const o = controlling();
    expect(o.onRateChange(1, LATER, true)).toBe('ignore');
    expect(o.suspended).toBe(false);
  });

  it('re-applies only for known resets while in control', () => {
    const o = controlling();
    o.settle(LATER);
    expect(o.onRateChange(1, LATER + SETTLE_MS - 1, false)).toBe('reapply');
    expect(o.onRateChange(1, LATER + SETTLE_MS + 1, false)).toBe('suspend');
  });

  it('treats a quick return to AutoSpeed speed as a temporary change (press-and-hold)', () => {
    const o = controlling(1, 1.6);
    expect(o.onRateChange(2, LATER, false)).toBe('suspend');
    expect(o.onRateChange(1.6, LATER + 2000, false)).toBe('resume');
    expect(o.controlling).toBe(true);
    expect(o.suspended).toBe(false);
  });

  it('does not resume if the return comes much later', () => {
    const o = controlling(1, 1.6);
    o.onRateChange(2, LATER, false);
    expect(o.onRateChange(1.6, LATER + TEMPORARY_MS + 1, false)).toBe('ignore');
    expect(o.suspended).toBe(true);
  });
});

describe('Giving the speed back', () => {
  it('restores the user speed captured before the first change', () => {
    const o = controlling(1, 1.6);
    o.take(1.8, 1.6); // later changes don't overwrite the user speed
    expect(o.release()).toBe(1);
    expect(o.controlling).toBe(false);
  });

  it('restores the original user speed after moving to another video (not AutoSpeed\'s old speed)', () => {
    const o = controlling(1, 1.6);
    expect(o.release()).toBe(1); // leaving video A
    o.onRateChange(1, LATER, false); // our own restore
    o.newVideo(LATER);
    o.take(1.4, 1); // video B: AutoSpeed takes over from the restored speed
    expect(o.release()).toBe(1);
  });

  it('does not count its own restore as a user change', () => {
    const o = controlling(1, 1.6);
    o.release();
    expect(o.onRateChange(1, LATER, false)).toBe('own');
    expect(o.suspended).toBe(false);
  });

  it('leaves the speed alone when it was not in control (e.g. the user picked a speed)', () => {
    const o = controlling(1, 1.6);
    o.onRateChange(1.25, LATER, false); // suspend: user chose 1.25
    expect(o.release()).toBeNull();
  });

  it('adopts the speed YouTube sets while a new video settles', () => {
    const o = new RateOwner();
    o.newVideo(LATER);
    expect(o.onRateChange(1.5, LATER + 500, false)).toBe('ignore');
    expect(o.userRate).toBe(1.5);
    expect(o.suspended).toBe(false);
  });
});
