/**
 * The "Smart pacing" card used by the popup and the welcome page. It renders the user-facing
 * state and owns the single setup action. Technical details (raw availability, error text) go
 * to the onboarding record for the Advanced section, never into this card.
 */
import {
  SMART_PACING_COPY,
  reconcileSmartPacing,
  saveOnboarding,
  setUpSmartPacing,
  smartPacingState,
  type SmartPacingState,
} from './onboarding';
import { loadSettings } from './settings';

export interface SmartCardOptions {
  /** States in which the card is hidden (e.g. the popup stays quiet when it's unavailable). */
  hideIn: SmartPacingState[];
  /** Called after each render, e.g. to refresh diagnostics. */
  onChange?: () => void;
}

export class SmartCard {
  private title: HTMLElement;
  private body: HTMLElement;
  private progress: HTMLElement;
  private action: HTMLButtonElement;
  private busy = false;
  private failed = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private root: HTMLElement,
    private opts: SmartCardOptions,
  ) {
    const q = <T extends HTMLElement>(k: string) => root.querySelector<T>(`[data-sp="${k}"]`)!;
    this.title = q('title');
    this.body = q('body');
    this.progress = q('progress');
    this.action = q<HTMLButtonElement>('action');
    this.action.addEventListener('click', () => void this.setUp());
  }

  async refresh(): Promise<void> {
    if (this.busy) return;
    const availability = await reconcileSmartPacing();
    const { mode } = await loadSettings();
    this.render(smartPacingState(availability, mode));
  }

  private render(state: SmartPacingState): void {
    this.root.hidden = this.opts.hideIn.includes(state) && !this.failed;
    const copy = SMART_PACING_COPY[state];
    if (this.failed && state === 'offer') {
      this.title.textContent = "Smart pacing couldn't be set up";
      this.body.textContent = 'AutoSpeed keeps adjusting to how fast people talk. You can try again anytime.';
      this.action.textContent = 'Try again';
      this.action.hidden = false;
    } else {
      this.title.textContent = copy.title;
      this.body.textContent = copy.body;
      this.action.hidden = !copy.action;
      if (copy.action) this.action.textContent = copy.action;
    }
    if (state !== 'downloading') this.progress.hidden = true;
    // While Chrome downloads in the background, check back until it's ready.
    if (state === 'downloading' && !this.pollTimer) this.pollTimer = setInterval(() => void this.refresh(), 3000);
    if (state !== 'downloading' && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.opts.onChange?.();
  }

  private async setUp(): Promise<void> {
    this.busy = true;
    this.failed = false;
    this.render('downloading');
    this.progress.hidden = false;
    this.progress.textContent = 'Starting…';
    try {
      await setUpSmartPacing((f) => (this.progress.textContent = `${Math.round(f * 100)}% downloaded`));
      await saveOnboarding({ lastSetupError: null });
    } catch (e) {
      this.failed = true;
      await saveOnboarding({ lastSetupError: e instanceof Error ? e.message : String(e) });
    }
    this.busy = false;
    await this.refresh();
  }
}
