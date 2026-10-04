import type { Mode, ProfileName } from './types';

export interface Settings {
  enabled: boolean;
  mode: Mode;
  profile: ProfileName;
  showOverlay: boolean;
  /** Briefly turn CC on (then restore) so the player fetches the caption track we can capture. */
  autoEnableCaptions: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  mode: 'baseline',
  profile: 'normal',
  showOverlay: true,
  autoEnableCaptions: true,
};

const KEY = 'autospeed.settings';

export async function loadSettings(): Promise<Settings> {
  const got = await chrome.storage.local.get(KEY);
  return { ...DEFAULT_SETTINGS, ...(got[KEY] as Partial<Settings> | undefined) };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

export function onSettingsChanged(cb: (s: Settings) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[KEY]) return;
    cb({ ...DEFAULT_SETTINGS, ...(changes[KEY].newValue as Partial<Settings>) });
  });
}
