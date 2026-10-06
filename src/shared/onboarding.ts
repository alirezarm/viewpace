/**
 * First-run and smart-pacing setup state. "Smart pacing" is the user-facing name for AI mode;
 * nothing here changes how speeds are chosen, only which mode is on and what the UI says.
 */
import { downloadNanoModel, nanoAvailability } from './nano';
import { loadSettings, saveSettings } from './settings';
import type { AiAvailability, Mode } from './types';

export interface Onboarding {
  /** The welcome page has been shown (opened once on install). */
  welcomed: boolean;
  /** The user picked an analysis mode themselves; never switch it for them after that. */
  modeChosenByUser: boolean;
  /** When smart pacing was switched on automatically (epoch ms), for diagnostics. */
  autoEnabledAt: number | null;
  /** Technical reason the last setup attempt failed, shown only under Advanced. */
  lastSetupError: string | null;
}

const DEFAULT_ONBOARDING: Onboarding = {
  welcomed: false,
  modeChosenByUser: false,
  autoEnabledAt: null,
  lastSetupError: null,
};
const KEY = 'autospeed.onboarding';

export async function loadOnboarding(): Promise<Onboarding> {
  const got = await chrome.storage.local.get(KEY);
  return { ...DEFAULT_ONBOARDING, ...(got[KEY] as Partial<Onboarding> | undefined) };
}

export async function saveOnboarding(patch: Partial<Onboarding>): Promise<Onboarding> {
  const next = { ...(await loadOnboarding()), ...patch };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

// ---------- states, in user terms ----------

export type SmartPacingState =
  | 'on' // ready and in use
  | 'off-by-choice' // ready, but the user picked "Speech only"
  | 'offer' // needs a one-time download
  | 'downloading'
  | 'unavailable'; // not supported here, or failed: ViewPace carries on without it

export function smartPacingState(availability: AiAvailability, mode: Mode): SmartPacingState {
  if (availability === 'available') return mode === 'ai' ? 'on' : 'off-by-choice';
  if (availability === 'downloadable') return 'offer';
  if (availability === 'downloading') return 'downloading';
  return 'unavailable';
}

/** Switch smart pacing on once it's ready, unless the user has chosen a mode themselves. */
export function shouldAutoEnable(availability: AiAvailability, mode: Mode, onboarding: Onboarding): boolean {
  return availability === 'available' && mode !== 'ai' && !onboarding.modeChosenByUser;
}

export interface SmartPacingCopy {
  title: string;
  body: string;
  /** The single action offered, if any. */
  action: string | null;
}

export const SMART_PACING_COPY: Record<SmartPacingState, SmartPacingCopy> = {
  on: {
    title: 'Smart pacing is on',
    body: "ViewPace also follows what's being said: it slows down when new ideas come up and speeds through small talk.",
    action: null,
  },
  'off-by-choice': {
    title: 'Smart pacing is off',
    body: 'ViewPace adjusts to how fast people talk. You can turn smart pacing on under Advanced.',
    action: null,
  },
  offer: {
    title: 'Make ViewPace smarter',
    body:
      "Smart pacing also follows what's being said, so it slows down when new ideas come up and speeds through " +
      'small talk. It runs privately on your computer after a one-time download, and ViewPace keeps working meanwhile.',
    action: 'Turn on smart pacing',
  },
  downloading: {
    title: 'Setting up smart pacing',
    body: "It turns on by itself when it's ready. ViewPace keeps working meanwhile.",
    action: null,
  },
  unavailable: {
    title: "Smart pacing isn't available on this computer",
    body: 'ViewPace adjusts to how fast people talk instead. Everything else works the same.',
    action: null,
  },
};

// ---------- actions ----------

/** The user picked an analysis mode in Advanced or the debug overlay. */
export async function chooseMode(mode: Mode): Promise<void> {
  await saveOnboarding({ modeChosenByUser: true });
  await saveSettings({ mode });
}

/**
 * Turn smart pacing on if it's ready and the user hasn't chosen otherwise. Safe to call often
 * (on install, on startup, whenever availability is checked). Returns the current availability.
 */
export async function reconcileSmartPacing(known?: AiAvailability): Promise<AiAvailability> {
  const availability = known ?? (await nanoAvailability());
  if (availability !== 'available') return availability;
  const [settings, onboarding] = await Promise.all([loadSettings(), loadOnboarding()]);
  if (shouldAutoEnable(availability, settings.mode, onboarding)) {
    await saveOnboarding({ autoEnabledAt: Date.now() });
    await saveSettings({ mode: 'ai' });
  }
  return availability;
}

/**
 * The one setup action. Must run from a user gesture (button click). Downloads the on-device
 * model, then turns smart pacing on. Clicking "Turn on smart pacing" is an explicit choice,
 * so it enables AI mode even if the user previously picked a mode.
 */
export async function setUpSmartPacing(onProgress?: (fraction: number) => void): Promise<void> {
  await downloadNanoModel(onProgress);
  await saveSettings({ mode: 'ai' });
}
