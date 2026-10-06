import { describe, expect, it } from 'vitest';
import { toggleCaptionsForTrack, type CaptionToggleDeps } from '../src/content/caption-toggle';

/** A fake player: one CC toggle, a virtual clock, and scripted events at given times. */
function fakePlayer(opts: { ccOn: boolean; respondAt?: number; navigateAt?: number }) {
  let on = opts.ccOn;
  let clock = 0;
  const clicks: string[] = [];
  const deps: CaptionToggleDeps = {
    button: () => ({ isOn: () => on, click: () => { on = !on; clicks.push(on ? 'on' : 'off'); } }),
    sleep: async (ms) => { clock += ms; },
    isCurrent: () => opts.navigateAt === undefined || clock < opts.navigateAt,
    responded: () => opts.respondAt !== undefined && clock >= opts.respondAt,
    waitMs: 2500,
  };
  return { deps, clicks, ccOn: () => on, clock: () => clock };
}

describe('toggling CC to load the caption track', () => {
  it('turns CC on, waits for the response, and turns it back off', async () => {
    const p = fakePlayer({ ccOn: false, respondAt: 400 });
    expect(await toggleCaptionsForTrack(p.deps)).toBe('done');
    expect(p.clicks).toEqual(['on', 'off']);
    expect(p.ccOn()).toBe(false);
    expect(p.clock()).toBe(400); // stopped waiting as soon as the response arrived
  });

  it('leaves CC on when the user had it on', async () => {
    const p = fakePlayer({ ccOn: true, respondAt: 600 });
    expect(await toggleCaptionsForTrack(p.deps)).toBe('done');
    expect(p.clicks).toEqual(['off', 'on']);
    expect(p.ccOn()).toBe(true);
  });

  it('stops waiting when the user moves to another video, still restoring CC', async () => {
    const p = fakePlayer({ ccOn: false, navigateAt: 500 }); // no response for the old video
    expect(await toggleCaptionsForTrack(p.deps)).toBe('navigated');
    expect(p.ccOn()).toBe(false); // the user's CC preference is back
    expect(p.clock()).toBe(500); // did not keep waiting the full 2.5 s
  });

  it('does not switch CC on for the next video if navigation happened before it was switched on', async () => {
    const p = fakePlayer({ ccOn: true, navigateAt: 100 }); // navigated during the first 300 ms pause
    expect(await toggleCaptionsForTrack(p.deps)).toBe('navigated');
    expect(p.clicks).toEqual(['off', 'on']); // only restored the user's original "on"
    expect(p.ccOn()).toBe(true);
  });

  it('does nothing without a CC button', async () => {
    const p = fakePlayer({ ccOn: false });
    expect(await toggleCaptionsForTrack({ ...p.deps, button: () => null })).toBe('no-button');
  });
});
