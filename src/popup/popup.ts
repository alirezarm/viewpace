import { PROFILES } from '../content/controller';
import { formatRate } from '../content/badge';
import { clearLog, readLog } from '../shared/log';
import { clearStats, loadStats, summarize, type BetaSummary, type SummaryColumn } from '../shared/stats';
import type { GoalTabRequest, TabRequest, TabStatus } from '../shared/messages';
import type { GoalStatus } from '../content/goal/goal-session';
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

  if (!settings.enabled) now.textContent = 'ViewPace is off.';
  else if (!status?.onVideo) now.textContent = 'Open a YouTube video to see ViewPace at work.';
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
  $<HTMLInputElement>('decisionlog').checked = settings.keepDecisionLog;
  document.querySelectorAll<HTMLInputElement>('input[name=mode]').forEach((r) => (r.checked = r.value === settings.mode));
  document.querySelectorAll<HTMLInputElement>('input[name=profile]').forEach((r) => (r.checked = r.value === settings.profile));

  void smart.refresh();
  renderPace(await activeTabStatus());
  void renderDiagnostics();

  const log = await readLog();
  const rated = log.filter((e) => e.feedback).length;
  const decisions = log.filter((e) => e.kind !== 'feedback').length;
  $('logcount').textContent = `${rated} feedback clicks, ${decisions} logged decisions`;
  renderSummary(summarize(log, await loadStats()));
}

async function renderDiagnostics(): Promise<void> {
  $('nano').textContent = await nanoAvailability();
  const o = await loadOnboarding();
  const parts = [o.modeChosenByUser ? 'Analysis mode chosen manually.' : 'Analysis mode set automatically.'];
  if (o.autoEnabledAt) parts.push(`Smart pacing turned on automatically ${new Date(o.autoEnabledAt).toLocaleString()}.`);
  if (o.lastSetupError) parts.push(`Last setup error: ${o.lastSetupError}`);
  $('setup-diag').textContent = parts.join(' ');
}

/** Below this many ratings, percentages are anecdotal. */
const FEW_RATINGS = 20;

function renderSummary(s: BetaSummary): void {
  const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);
  const rows: [string, (c: SummaryColumn) => string][] = [
    ['Ratings', (c) => String(c.feedback)],
    ['Just right', (c) => pct(c.justRight)],
    ['Too slow', (c) => pct(c.tooSlow)],
    ['Too fast', (c) => pct(c.tooFast)],
    ['Avg speed', (c) => (c.avgSpeed === null ? '—' : `${c.avgSpeed.toFixed(2)}×`)],
    ['Watched', (c) => `${Math.round(c.playMinutes)} min`],
    ['Videos', (c) => String(c.videos)],
    ['Overrides', (c) => String(c.overrides)],
    ['Per video', (c) => (c.overridesPerVideo === null ? '—' : c.overridesPerVideo.toFixed(2))],
  ];
  const cols = [s.byAnalysis.speech, s.byAnalysis.content, s.total];
  const body = $('summary').querySelector('tbody')!;
  body.replaceChildren(
    ...rows.map(([label, cell]) => {
      const tr = document.createElement('tr');
      for (const text of [label, ...cols.map(cell)]) {
        const td = document.createElement('td');
        td.textContent = text;
        tr.append(td);
      }
      return tr;
    }),
  );
  const notes: string[] = [];
  if (s.since) notes.push(`Usage counted since ${new Date(s.since).toLocaleDateString()}.`);
  notes.push('Avg speed and overrides cover time when ViewPace was choosing the speed.');
  if (cols.slice(0, 2).some((c) => c.feedback < FEW_RATINGS)) notes.push(`Under ${FEW_RATINGS} ratings in a column is too few to compare.`);
  notes.push('Not a controlled comparison: the two columns cover different videos and moments.');
  $('summary-note').textContent = notes.join(' ');
}

// ---------- Goal Mode (experimental) ----------

async function sendGoal(req: GoalTabRequest): Promise<GoalStatus | { error: string } | null | undefined> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) return undefined;
    return (await chrome.tabs.sendMessage(tab.id, req)) as GoalStatus | { error: string } | null;
  } catch {
    return undefined; // not a YouTube tab
  }
}

function renderGoal(status: GoalStatus | { error: string } | null | undefined, onVideo: boolean): void {
  const start = $<HTMLButtonElement>('goal-start');
  const stop = $<HTMLButtonElement>('goal-stop');
  const text = $('goal-status');
  start.disabled = !onVideo;
  if (status === undefined) {
    if (!onVideo) text.textContent = 'Open a YouTube video to use Goal Mode.';
    stop.hidden = true;
    return;
  }
  if (status && 'error' in status) {
    text.textContent = status.error;
    return;
  }
  const running = status !== null && (status.phase === 'mapping' || status.phase === 'ready');
  stop.hidden = !running;
  start.textContent = running ? 'Restart with this goal' : 'Start Goal Mode';
  if (status) text.textContent = status.message;
}

async function refreshGoal(onVideo: boolean): Promise<void> {
  if ($<HTMLDetailsElement>('goal').open) renderGoal(await sendGoal({ kind: 'goal:status' }), onVideo);
}

// ---------- actions ----------

function bind(): void {
  const patch = (p: Partial<Settings>) => void saveSettings(p);
  const onCheck = (id: string, key: 'enabled' | 'showOverlay' | 'debugOverlay' | 'autoEnableCaptions' | 'keepDecisionLog') =>
    $<HTMLInputElement>(id).addEventListener('change', (e) => patch({ [key]: (e.target as HTMLInputElement).checked }));
  onCheck('enabled', 'enabled');
  onCheck('overlay', 'showOverlay');
  onCheck('debug', 'debugOverlay');
  onCheck('autocc', 'autoEnableCaptions');
  onCheck('decisionlog', 'keepDecisionLog');
  document.querySelectorAll<HTMLInputElement>('input[name=mode]').forEach((r) =>
    r.addEventListener('change', () => void chooseMode(r.value as Settings['mode'])),
  );
  document.querySelectorAll<HTMLInputElement>('input[name=profile]').forEach((r) =>
    r.addEventListener('change', () => patch({ profile: r.value as Settings['profile'] })),
  );

  $<HTMLButtonElement>('export').addEventListener('click', async () => {
    // Raw data: the bounded feedback/decision log plus the fixed-size usage counters.
    const data = { exportedAt: new Date().toISOString(), usage: await loadStats(), log: await readLog() };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `viewpace-log-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });

  $<HTMLButtonElement>('clear').addEventListener('click', async () => {
    if (!confirm('Delete all feedback, logged decisions and usage counters?')) return;
    await Promise.all([clearLog(), clearStats()]);
    void render();
  });

  $<HTMLButtonElement>('goal-start').addEventListener('click', async () => {
    const goalText = $<HTMLTextAreaElement>('goal-text').value;
    renderGoal(await sendGoal({ kind: 'goal:start', goal: goalText }), true);
  });
  $<HTMLButtonElement>('goal-stop').addEventListener('click', async () => {
    await sendGoal({ kind: 'goal:stop' });
    $('goal-status').textContent = 'Goal Mode stopped.';
    $<HTMLButtonElement>('goal-stop').hidden = true;
    $<HTMLButtonElement>('goal-start').textContent = 'Start Goal Mode';
  });
  $<HTMLDetailsElement>('goal').addEventListener('toggle', () => void activeTabStatus().then((s) => refreshGoal(Boolean(s?.onVideo))));

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
// Keep the live speed (and Goal Mode progress) current while the popup is open.
setInterval(() => {
  if (!settings) return;
  void activeTabStatus().then((s) => {
    renderPace(s);
    void refreshGoal(Boolean(s?.onVideo));
  });
}, 1000);
