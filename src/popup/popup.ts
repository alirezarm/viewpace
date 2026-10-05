import { clearLog, readLog } from '../shared/log';
import { downloadNanoModel, nanoAvailability } from '../shared/nano';
import { loadSettings, saveSettings, type Settings } from '../shared/settings';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function render(): Promise<void> {
  const s = await loadSettings();
  $<HTMLInputElement>('enabled').checked = s.enabled;
  $<HTMLInputElement>('overlay').checked = s.showOverlay;
  $<HTMLInputElement>('autocc').checked = s.autoEnableCaptions;
  document.querySelectorAll<HTMLInputElement>('input[name=mode]').forEach((r) => (r.checked = r.value === s.mode));
  document.querySelectorAll<HTMLInputElement>('input[name=profile]').forEach((r) => (r.checked = r.value === s.profile));

  const status = await nanoAvailability();
  $('nano').textContent = status;
  $<HTMLButtonElement>('download').hidden = status !== 'downloadable' && status !== 'downloading';

  const log = await readLog();
  const withFb = log.filter((e) => e.feedback).length;
  $('logcount').textContent = `${log.length} decisions, ${withFb} with feedback`;
}

function bind(): void {
  const patch = (p: Partial<Settings>) => void saveSettings(p);
  $<HTMLInputElement>('enabled').addEventListener('change', (e) => patch({ enabled: (e.target as HTMLInputElement).checked }));
  $<HTMLInputElement>('overlay').addEventListener('change', (e) => patch({ showOverlay: (e.target as HTMLInputElement).checked }));
  $<HTMLInputElement>('autocc').addEventListener('change', (e) =>
    patch({ autoEnableCaptions: (e.target as HTMLInputElement).checked }),
  );
  document.querySelectorAll<HTMLInputElement>('input[name=mode]').forEach((r) =>
    r.addEventListener('change', () => patch({ mode: r.value as Settings['mode'] })),
  );
  document.querySelectorAll<HTMLInputElement>('input[name=profile]').forEach((r) =>
    r.addEventListener('change', () => patch({ profile: r.value as Settings['profile'] })),
  );

  // Model download needs a user gesture, so it happens here rather than in the service worker.
  $<HTMLButtonElement>('download').addEventListener('click', async () => {
    const progress = $('progress');
    try {
      await downloadNanoModel((f) => (progress.textContent = `downloading ${Math.round(f * 100)}%`));
      progress.textContent = 'ready';
    } catch (e) {
      progress.textContent = `failed: ${e instanceof Error ? e.message : String(e)}`;
    }
    void render();
  });

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
}

bind();
void render();
