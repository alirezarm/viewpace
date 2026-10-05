import { PROFILES } from '../content/controller';
import { formatRate } from '../content/badge';
import { loadSettings, saveSettings, type Settings } from '../shared/settings';
import { SmartCard } from '../shared/smart-card';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const PACE_NOTES: Record<Settings['profile'], string> = {
  relaxed: `Relaxed stays close to normal speed and never goes above ${formatRate(PROFILES.relaxed.maxRate)}.`,
  normal: 'Normal is a good start for most videos.',
  fast: `Fast is for confident listeners and goes up to ${formatRate(PROFILES.fast.maxRate)}.`,
};

function renderPace(profile: Settings['profile']): void {
  const r = PROFILES[profile];
  $('min').textContent = formatRate(r.minRate);
  $('max').textContent = formatRate(r.maxRate);
  // Illustrate where the pace usually sits: its default speed within its range.
  $('dot').style.left = `${(((r.defaultRate - r.minRate) / (r.maxRate - r.minRate)) * 100).toFixed(1)}%`;
  $('pace-note').textContent = PACE_NOTES[profile];
  document.querySelectorAll<HTMLInputElement>('input[name=profile]').forEach((i) => (i.checked = i.value === profile));
}

async function init(): Promise<void> {
  const settings = await loadSettings();
  renderPace(settings.profile);
  document.querySelectorAll<HTMLInputElement>('input[name=profile]').forEach((i) =>
    i.addEventListener('change', () => {
      renderPace(i.value as Settings['profile']);
      void saveSettings({ profile: i.value as Settings['profile'] });
    }),
  );

  // The welcome page is the one place we mention, once, that smart pacing isn't available here.
  const smart = new SmartCard($('smart'), { hideIn: ['off-by-choice'] });
  await smart.refresh();
}

void init();
