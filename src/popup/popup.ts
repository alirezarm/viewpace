import { PROFILES } from '../content/controller';
import { formatRate } from '../content/badge';
import { clearLog, readLog } from '../shared/log';
import type { TabRequest, TabStatus } from '../shared/messages';
import { nanoAvailability } from '../shared/nano';
import { chooseMode, loadOnboarding } from '../shared/onboarding';
import { SmartCard } from '../shared/smart-card';
import { loadSettings, onSettingsChanged, saveSettings, type Settings } from '../shared/settings';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let settings: Settings;
// The popup stays quiet about smart pacing unless there's something useful to offer or report.
const smart = new SmartCard($('smart'), { hideIn: ['unavailable', 'off-by-choice'] });

// ---------- live status from the active tab ----------

async function activeTabStatus(): Promise<TabStatus | null> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) return null;
    return (await chrome.tabs.sendMessage(tab.id, { kind: 'tab:status' } satisfies TabRequest)) as TabStatus;
  } catch {
    return null; // not a YouTube tab (no content script to answer)
  }
}

function renderPace(status: TabStatus | null): void {
  const range = PROFILES[settings.profile];
  $('min').textContent = formatRate(range.minRate);
  $('max').textContent = formatRate(range.maxRate);

  const dot = $('dot');
  const now = $('now');
  const live =
    settings.enabled && status?.onVideo && status.rate !== null && (status.state === 'active' || status.state === 'paused-by-user');
  dot.hidden = !live;
  if (live) {
    const pos = Math.min(1, Math.max(0, (status.rate! - range.minRate) / (range.maxRate - range.minRate)));
    dot.style.left = `${(pos * 100).toFixed(1)}%`;
    dot.classList.toggle('paused', status.state === 'paused-by-user');
  }

  if (!settings.enabled) now.textContent = 'AutoSpeed is off.';
  else if (!status?.onVideo) now.textContent = 'Open a YouTube video to see AutoSpeed at work.';
  else if (status.state === 'paused-by-user')
    now.textContent = `Paused because you chose ${formatRate(status.rate ?? 1)}. Resume from the badge on the video.`;
  else if (status.state === 'ad') now.textContent = 'Waiting for the ad to finish.';
  else if (status.state === 'unsupported') now.textContent = "Live streams aren't supported yet.";
  else {
    now.textContent = '';
    const strong = document.createElement('strong');
    strong.textContent = formatRate(status.rate ?? 1);
    now.append('Now ', strong, ' on this video');
  }
}

// ---------- render ----------

async function render(): Promise<void> {
  settings = await loadSettings();
  $<HTMLInputElement>('enabled').checked = settings.enabled;
  $<HTMLInputElement>('overlay').checked = settings.showOverlay;
  $<HTMLInputElement>('debug').checked = settings.debugOverlay;
  $<HTMLInputElement>('autocc').checked = settings.autoEnableCaptions;
  document.querySelectorAll<HTMLInputElement>('input[name=mode]').forEach((r) => (r.checked = r.value === settings.mode));
  document.querySelectorAll<HTMLInputElement>('input[name=profile]').forEach((r) => (r.checked = r.value === settings.profile));

  void smart.refresh();
  renderPace(await activeTabStatus());
  void renderDiagnostics();

  const log = await readLog();
  const rated = log.filter((e) => e.feedback).length;
  $('logcount').textContent = `${log.length} decisions, ${rated} with feedback`;
}

async function renderDiagnostics(): Promise<void> {
  $('nano').textContent = await nanoAvailability();
  const o = await loadOnboarding();
  const parts = [o.modeChosenByUser ? 'Analysis mode chosen manually.' : 'Analysis mode set automatically.'];
  if (o.autoEnabledAt) parts.push(`Smart pacing turned on automatically ${new Date(o.autoEnabledAt).toLocaleString()}.`);
  if (o.lastSetupError) parts.push(`Last setup error: ${o.lastSetupError}`);
  $('setup-diag').textContent = parts.join(' ');
}

// ---------- actions ----------

function bind(): void {
  const patch = (p: Partial<Settings>) => void saveSettings(p);
  const onCheck = (id: string, key: 'enabled' | 'showOverlay' | 'debugOverlay' | 'autoEnableCaptions') =>
    $<HTMLInputElement>(id).addEventListener('change', (e) => patch({ [key]: (e.target as HTMLInputElement).checked }));
  onCheck('enabled', 'enabled');
  onCheck('overlay', 'showOverlay');
  onCheck('debug', 'debugOverlay');
  onCheck('autocc', 'autoEnableCaptions');
  document.querySelectorAll<HTMLInputElement>('input[name=mode]').forEach((r) =>
    r.addEventListener('change', () => void chooseMode(r.value as Settings['mode'])),
  );
  document.querySelectorAll<HTMLInputElement>('input[name=profile]').forEach((r) =>
    r.addEventListener('change', () => patch({ profile: r.value as Settings['profile'] })),
  );

  $<HTMLButtonElement>('export').addEventListener('click', async () => {
    const log = await readLog();
    const blob = new Blob([JSON.stringify(log, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `autospeed-log-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });

  $<HTMLButtonElement>('clear').addEventListener('click', async () => {
    if (!confirm('Delete all logged decisions and feedback?')) return;
    await clearLog();
    void render();
  });

  // Remember whether Advanced was open (a per-browser convenience only).
  const adv = $<HTMLDetailsElement>('advanced');
  try {
    adv.open = localStorage.getItem('autospeed.advancedOpen') === '1';
  } catch {
    /* storage unavailable: start closed */
  }
  adv.addEventListener('toggle', () => {
    try {
      localStorage.setItem('autospeed.advancedOpen', adv.open ? '1' : '0');
    } catch {
      /* ignore */
    }
  });
}

bind();
void render();
onSettingsChanged(() => void render());
// Keep the live speed current while the popup is open.
setInterval(() => {
  if (settings) void activeTabStatus().then(renderPace);
}, 1000);
