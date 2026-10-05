import type { Feedback } from '../shared/types';

/** What the minimal in-video badge shows. Debug details live in overlay.ts instead. */
export interface BadgeView {
  state: 'active' | 'off' | 'paused-by-user';
  rate: number;
  /** Current pace range, for the little track. */
  minRate: number;
  maxRate: number;
  /** One short sentence; shown while controls are visible or during a flash. */
  line: string | null;
  /** Keep the badge visible even when YouTube hides its controls (e.g. right after a speed change). */
  flash: boolean;
  ack: string | null;
}

export interface BadgeHandlers {
  onFeedback(f: Feedback): void;
  onToggleEnabled(): void;
  onResume(): void;
}

const HOST_ID = 'autospeed-badge';

// Light-DOM rule: follow YouTube's own control visibility (it adds .ytp-autohide to the player).
const PAGE_CSS = `
#movie_player > #${HOST_ID} { position: absolute; right: 12px; bottom: 64px; z-index: 60;
  transition: opacity .2s ease; }
#movie_player.ytp-autohide > #${HOST_ID}:not([data-flash]):not([data-open]) { opacity: 0; pointer-events: none; }
#movie_player.ytp-fullscreen > #${HOST_ID} { bottom: 84px; right: 24px; }
@media (prefers-reduced-motion: reduce) { #movie_player > #${HOST_ID} { transition: none; } }
`;

// Matches YouTube's player menus: translucent graphite, YouTube Sans/Roboto, 12px radius.
const CSS = `
:host { all: initial; }
[hidden] { display: none !important; }
* { box-sizing: border-box; }
.wrap { display: flex; flex-direction: column; align-items: flex-end; gap: 6px;
  font: 500 13px/1.3 "YouTube Sans", Roboto, Arial, sans-serif; color: #f1f1f1; }
button { font: inherit; color: inherit; cursor: pointer; border: 0; }
button:focus-visible { outline: 2px solid #ffc857; outline-offset: 2px; }

.pill { display: flex; align-items: center; gap: 8px; padding: 6px 10px 6px 8px; border-radius: 12px;
  background: rgba(28,28,28,.9); max-width: 340px; }
.pill:hover { background: rgba(48,48,48,.95); }
.track { position: relative; width: 28px; height: 4px; border-radius: 2px; background: rgba(255,255,255,.25); flex: none; }
.dot { position: absolute; top: 50%; width: 8px; height: 8px; margin: -4px 0 0 -4px; border-radius: 50%;
  background: #ffc857; transition: left .4s ease; }
.off .dot { background: #9a9a9a; }
.paused .dot { background: transparent; box-shadow: inset 0 0 0 2px #ffc857; }
.rate { font-weight: 700; font-variant-numeric: tabular-nums; }
.off .rate { color: #bdbdbd; font-weight: 500; }
.line { color: #d6d6d6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.panel { display: flex; flex-direction: column; gap: 10px; width: 248px; padding: 12px; border-radius: 12px;
  background: rgba(28,28,28,.94); }
.q { margin: 0; font-weight: 600; }
.fb { display: flex; gap: 6px; }
.fb button, .secondary { flex: 1; padding: 7px 4px; border-radius: 8px; background: rgba(255,255,255,.1); }
.fb button:hover, .secondary:hover { background: rgba(255,255,255,.2); }
.ack { margin: 0; color: #ffc857; }
.secondary { display: block; width: 100%; }
.resume { padding: 6px 12px; border-radius: 12px; background: #ffc857; color: #1a1a1a; font-weight: 600; }
@media (prefers-reduced-motion: reduce) { .dot { transition: none; } }
`;

export class Badge {
  private host: HTMLDivElement;
  private root: ShadowRoot;
  private el: Record<string, HTMLElement> = {};
  private open = false;

  constructor(private handlers: BadgeHandlers) {
    if (!document.getElementById('autospeed-badge-style')) {
      const style = document.createElement('style');
      style.id = 'autospeed-badge-style';
      style.textContent = PAGE_CSS;
      (document.head ?? document.documentElement).appendChild(style);
    }
    this.host = document.createElement('div');
    this.host.id = HOST_ID;
    this.root = this.host.attachShadow({ mode: 'open' });
    this.root.innerHTML = `
      <style>${CSS}</style>
      <div class="wrap">
        <div class="panel" data-k="panel" hidden role="dialog" aria-label="AutoSpeed">
          <p class="q" data-k="q">How's the speed?</p>
          <div class="fb" data-k="fb">
            <button data-f="too_slow">Too slow</button>
            <button data-f="good">Just right</button>
            <button data-f="too_fast">Too fast</button>
          </div>
          <p class="ack" data-k="ack" aria-live="polite"></p>
          <button class="secondary" data-k="toggle"></button>
        </div>
        <button class="resume" data-k="resume" hidden>Resume AutoSpeed</button>
        <button class="pill" data-k="pill" aria-expanded="false" aria-label="AutoSpeed: show options">
          <span class="track" aria-hidden="true"><span class="dot" data-k="dot"></span></span>
          <span class="rate" data-k="rate"></span>
          <span class="line" data-k="line" hidden></span>
        </button>
      </div>`;
    this.root.querySelectorAll<HTMLElement>('[data-k]').forEach((e) => (this.el[e.dataset.k!] = e));

    // Keep clicks and keys from reaching the YouTube player (which would pause or seek).
    for (const type of ['click', 'dblclick', 'mousedown', 'keydown']) {
      this.host.addEventListener(type, (e) => e.stopPropagation());
    }
    this.root.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const f = t.closest<HTMLElement>('[data-f]')?.dataset.f;
      if (f) return handlers.onFeedback(f as Feedback);
      const k = t.closest<HTMLElement>('[data-k]')?.dataset.k;
      if (k === 'pill') this.setOpen(!this.open);
      else if (k === 'toggle') {
        handlers.onToggleEnabled();
        this.setOpen(false);
      } else if (k === 'resume') handlers.onResume();
    });
    this.root.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Escape') this.setOpen(false);
    });
  }

  private setOpen(open: boolean): void {
    this.open = open;
    this.el.panel!.hidden = !open;
    this.el.pill!.setAttribute('aria-expanded', String(open));
    this.host.toggleAttribute('data-open', open);
  }

  setVisible(v: boolean): void {
    this.host.style.display = v ? '' : 'none';
    if (!v && this.open) this.setOpen(false);
  }

  update(v: BadgeView): void {
    const player = document.getElementById('movie_player');
    if (player && this.host.parentElement !== player) player.appendChild(this.host);

    const set = (k: string, text: string) => {
      const e = this.el[k];
      if (e && e.textContent !== text) e.textContent = text;
    };
    const pill = this.el.pill!;
    pill.classList.toggle('off', v.state === 'off');
    pill.classList.toggle('paused', v.state === 'paused-by-user');

    const span = Math.max(0.01, v.maxRate - v.minRate);
    const pos = Math.min(1, Math.max(0, (v.rate - v.minRate) / span));
    this.el.dot!.style.left = `${(pos * 100).toFixed(1)}%`;

    if (v.state === 'off') set('rate', 'AutoSpeed off');
    else if (v.state === 'paused-by-user') set('rate', `Paused: you chose ${formatRate(v.rate)}`);
    else set('rate', formatRate(v.rate));

    this.el.line!.hidden = !v.line;
    set('line', v.line ?? '');
    set('ack', v.ack ?? '');
    // Rating only makes sense while AutoSpeed is choosing the speed.
    const rating = v.state === 'active';
    this.el.q!.hidden = !rating;
    this.el.fb!.hidden = !rating;
    this.el.ack!.hidden = !rating || !v.ack;
    set('toggle', v.state === 'off' ? 'Turn on AutoSpeed' : 'Turn off AutoSpeed');
    this.el.resume!.hidden = v.state !== 'paused-by-user';
    this.host.toggleAttribute('data-flash', v.flash || v.state === 'paused-by-user');
  }
}

export function formatRate(r: number): string {
  return `${Number(r.toFixed(2))}×`;
}
