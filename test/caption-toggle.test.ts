import { describe, expect, it } from 'vitest';
import { toggleCaptionsForTrack, type CaptionToggleDeps } from '../src/content/caption-toggle';

interface Script {
  ccOn: boolean;
  respondAt?: number;
  /** URL changes to another video at this time (same player). */
  navigateAt?: number;
  /** YouTube replaces the player at this time; the new player's CC starts as `newPlayerCcOn`. */
  replacePlayerAt?: number;
  newPlayerCcOn?: boolean;
  /** Something else (the user) toggles CC at this time. */
  externalToggleAt?: number;
}

/** A fake player: CC toggles, a virtual clock, and scripted events at given times. */
function fakePlayer(s: Script) {
  let clock = 0;
  const players = [{ on: s.ccOn, connected: true }];
  const clicks: string[] = [];
  let replaced = false;
  let externallyToggled = false;
  const advance = () => {
    if (s.replacePlayerAt !== undefined && !replaced && clock >= s.replacePlayerAt) {
      replaced = true;
      players[0]!.connected = false;
      players.push({ on: s.newPlayerCcOn ?? false, connected: true });
    }
    if (s.externalToggleAt !== undefined && !externallyToggled && clock >= s.externalToggleAt) {
      externallyToggled = true;
      const p = players.at(-1)!;
      p.on = !p.on;
    }
  };
  const handle = (p: { on: boolean; connected: boolean }) => ({
    isOn: () => p.on,
    click: () => {
      p.on = !p.on;
      clicks.push(p.on ? 'on' : 'off');
    },
    isConnected: () => p.connected,
  });
  const deps: CaptionToggleDeps = {
    button: () => handle(players.at(-1)!),
    sleep: async (ms) => {
      clock += ms;
      advance();
    },
    isCurrent: () =>
      (s.navigateAt === undefined || clock < s.navigateAt) && (s.replacePlayerAt === undefined || clock < s.replacePlayerAt),
    responded: () => s.respondAt !== undefined && clock >= s.respondAt,
    waitMs: 2500,
  };
  return { deps, clicks, original: () => players[0]!.on, current: () => players.at(-1)!.on, clock: () => clock };
}

describe('toggling CC to load the caption track', () => {
  it('turns CC on, waits for the response, and turns it back off', async () => {
    const p = fakePlayer({ ccOn: false, respondAt: 400 });
    expect(await toggleCaptionsForTrack(p.deps)).toBe('done');
    expect(p.clicks).toEqual(['on', 'off']);
    expect(p.current()).toBe(false);
    expect(p.clock()).toBe(400); // stopped waiting as soon as the response arrived
  });

  it('leaves CC on when the user had it on', async () => {
    const p = fakePlayer({ ccOn: true, respondAt: 600 });
    expect(await toggleCaptionsForTrack(p.deps)).toBe('done');
    expect(p.clicks).toEqual(['off', 'on']);
    expect(p.current()).toBe(true);
  });

  it('stops waiting when the user moves to another video in the same player, restoring CC', async () => {
    const p = fakePlayer({ ccOn: false, navigateAt: 500 });
    expect(await toggleCaptionsForTrack(p.deps)).toBe('navigated');
    expect(p.current()).toBe(false); // the user's CC preference is back
    expect(p.clock()).toBe(500); // did not keep waiting the full 2.5 s
  });

  it('never switches CC on after navigating away during the first pause', async () => {
    const p = fakePlayer({ ccOn: true, navigateAt: 100 });
    expect(await toggleCaptionsForTrack(p.deps)).toBe('navigated');
    expect(p.clicks).toEqual(['off', 'on']); // only undid its own "off"
    expect(p.current()).toBe(true);
  });

  it('never touches a replaced player (cleanup does not turn off the next video\'s captions)', async () => {
    const p = fakePlayer({ ccOn: false, replacePlayerAt: 500, newPlayerCcOn: true });
    expect(await toggleCaptionsForTrack(p.deps)).toBe('navigated');
    expect(p.current()).toBe(true); // the new player's captions stay on
    expect(p.clicks).toEqual(['on']); // the only click was on the old player
  });

  it('leaves CC alone if someone else changed it during the wait', async () => {
    const p = fakePlayer({ ccOn: false, externalToggleAt: 300, respondAt: 2000 });
    // ViewPace switched CC on, then the user switched it off themselves at 300 ms.
    expect(await toggleCaptionsForTrack(p.deps)).toBe('done');
    expect(p.clicks).toEqual(['on']); // no "restore" click on top of the user's choice
    expect(p.current()).toBe(false);
  });

  it('does nothing without a CC button', async () => {
    const p = fakePlayer({ ccOn: false });
    expect(await toggleCaptionsForTrack({ ...p.deps, button: () => null })).toBe('no-button');
  });
});
