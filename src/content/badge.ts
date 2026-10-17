import type { Feedback } from '../shared/types';
import type { GoalCardView } from './goal/goal-coordinator';
import { VISUAL_TIERS, regionTooltip, seekFromKey, seekFromPointer, timelineClock, type GoalTimeline } from './goal/goal-timeline';

/** Slow / medium / fast tiers drawn with the existing key-part, background and not-relevant styles. */
const TIER_CLASS = ['l0', 'l2', 'l4'];

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
  /** Goal Mode's whole-video timeline, or null when Goal Mode is off. */
  timeline: GoalTimeline | null;
  /** The viewing-goal card shown with the Goal Map. */
  goalCard: GoalCardView;
}

export interface BadgeHandlers {
  onFeedback(f: Feedback): void;
  onToggleEnabled(): void;
  onResume(): void;
  /** The viewer picked a point on the Goal Map: seek the video there (seconds). */
  onSeek(time: number): void;
  /** Start (or restart) Goal Mode with this goal. */
  onGoalStart(goal: string): void;
  onGoalStop(): void;
  /** Resume Goal Mode with this video's saved goal. */
  onGoalResume(): void;
  /** Open or close the goal input. */
  onGoalEditing(editing: boolean): void;
}

/** Which sections of the one ViewPace card are shown. The speed/status row is always there. */
export interface CardLayout {
  goal: boolean;
  map: boolean;
  feedback: boolean;
  resume: boolean;
  /** Full width (anything beyond the status row); otherwise the card is just the compact status pill. */
  wide: boolean;
}

export function cardLayout(v: Pick<BadgeView, 'goalCard' | 'timeline' | 'state'>, feedbackOpen: boolean): CardLayout {
  const goal = v.goalCard.mode !== 'hidden';
  const map = v.timeline !== null && v.timeline.duration > 0;
  return { goal, map, feedback: feedbackOpen, resume: v.state === 'paused-by-user', wide: goal || map || feedbackOpen };
}

/** How long the answered feedback (and its thank-you) stays before the card collapses again. */
const FEEDBACK_LINGER_MS = 1500;

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
.wrap { display: flex; flex-direction: column; align-items: flex-end;
  font: 500 13px/1.3 "YouTube Sans", Roboto, Arial, sans-serif; color: #f1f1f1; }
/* The one ViewPace card: goal, Goal Map, current speed, and (when asked) speed feedback. */
.card { display: flex; flex-direction: column; gap: 6px; max-width: 340px; padding: 6px 10px 6px 8px; border-radius: 12px;
  background: rgba(28,28,28,.9); }
.card.wide { width: 272px; padding: 7px 9px 6px; }
button { font: inherit; color: inherit; cursor: pointer; border: 0; }
button:focus-visible { outline: 2px solid #ffc857; outline-offset: 2px; }

.pill { display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; padding: 0; border-radius: 6px;
  background: none; text-align: left; }
.pill:hover .line { color: #fff; }
.track { position: relative; width: 28px; height: 4px; border-radius: 2px; background: rgba(255,255,255,.25); flex: none; }
.dot { position: absolute; top: 50%; width: 8px; height: 8px; margin: -4px 0 0 -4px; border-radius: 50%;
  background: #ffc857; transition: left .4s ease; }
.off .dot { background: #9a9a9a; }
.paused .dot { background: transparent; box-shadow: inset 0 0 0 2px #ffc857; }
.rate { font-weight: 700; font-variant-numeric: tabular-nums; }
.off .rate { color: #bdbdbd; font-weight: 500; }
.line { color: #d6d6d6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.panel { display: flex; flex-direction: column; gap: 8px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,.12); }
.q { margin: 0; font-weight: 600; }
.fb { display: flex; gap: 6px; }
.fb button, .secondary { flex: 1; padding: 7px 4px; border-radius: 8px; background: rgba(255,255,255,.1); }
.fb button:hover, .secondary:hover { background: rgba(255,255,255,.2); }
.ack { margin: 0; color: #ffc857; }
.secondary { display: block; width: 100%; }
.panel .secondary { flex: none; padding: 0; background: none; color: #aaa; text-align: left; font-size: 12px; }
.panel .secondary:hover { color: #fff; background: none; }
.resume { padding: 6px 12px; border-radius: 8px; background: #ffc857; color: #1a1a1a; font-weight: 600; }

/* Goal Mode timeline: bar height = how much attention Goal Mode gives that part (taller = slower).
   Parts not mapped yet are striped, never short, so they can't be mistaken for "not relevant". */
.tl { position: relative; }
/* Hover card for one part of the map: the topic leads; time range above, pacing below. */
.tip { position: absolute; bottom: calc(100% + 6px); max-width: 240px; padding: 6px 9px; border-radius: 8px;
  background: rgba(20,20,20,.96); box-shadow: 0 2px 8px rgba(0,0,0,.4); pointer-events: none; white-space: normal; }
.tip .tr { font-size: 11px; color: #aaa; font-variant-numeric: tabular-nums; }
.tip .tt { font-size: 13px; font-weight: 600; color: #fff; margin-top: 1px; }
.tip .more { font-size: 12px; color: #aaa; margin-top: 1px; }
.tip .td { font-size: 12px; color: #d6d6d6; margin-top: 1px; }
.bar { position: relative; height: 16px; cursor: pointer; border-radius: 2px; }
/* Viewing goal, on top of the map: a prompt, the input, or the goal itself with an edit action. */
.goal + .map { margin-top: 7px; }
.gchip { display: block; width: 100%; padding: 0; text-align: left; background: none; color: #d6d6d6; font-size: 12px; }
.gchip:hover { color: #fff; }
.gline, .gsaved { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #f1f1f1; }
.gresume { flex: none; padding: 2px 8px; border-radius: 6px; background: #ffc857; color: #1a1a1a; font-weight: 600; font-size: 12px; }
.gtext { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gedit { flex: none; padding: 0 4px; border-radius: 6px; background: none; color: #aaa; font-size: 13px; }
.gedit:hover { color: #fff; background: rgba(255,255,255,.1); }
.gentry { display: flex; flex-direction: column; gap: 6px; margin: 0; font-size: 12px; }
.ghead { display: flex; align-items: center; gap: 6px; }
.gq { flex: 1; color: #d6d6d6; }
.gclose { flex: none; padding: 0 5px; border-radius: 6px; background: none; color: #aaa; font-size: 14px; line-height: 1.2; }
.gclose:hover { color: #fff; background: rgba(255,255,255,.1); }
.gtext { cursor: pointer; }
.gtext:hover { color: #fff; text-decoration: underline; text-decoration-color: rgba(255,255,255,.4); }
.grow { display: flex; gap: 6px; }
.grow input { flex: 1; min-width: 0; padding: 6px 8px; border: 1px solid rgba(255,255,255,.2); border-radius: 8px;
  background: rgba(0,0,0,.35); color: #f1f1f1; font: inherit; }
.grow input:focus { outline: 2px solid #ffc857; outline-offset: 0; border-color: transparent; }
.gstart { padding: 6px 10px; border-radius: 8px; background: #ffc857; color: #1a1a1a; font-weight: 600; }
.gprev { align-self: flex-start; max-width: 100%; padding: 0; background: none; color: #aaa; text-align: left;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gprev:hover { color: #fff; }
.gmsg { color: #ffc857; }
.gacts { display: flex; gap: 10px; }
.gacts button { padding: 0; background: none; color: #aaa; }
.gacts button:hover { color: #fff; }
.bar:focus-visible { outline: 2px solid #ffc857; outline-offset: 3px; }
.bar::before { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 2px; border-radius: 1px;
  background: rgba(255,255,255,.18); }
.seg { position: absolute; bottom: 0; box-shadow: inset -1px 0 rgba(28,28,28,.9); } /* 1px gap between parts */
.seg.pending { height: 100%; background: repeating-linear-gradient(135deg, rgba(255,255,255,.16) 0 2px, transparent 2px 5px); }
.seg.failed { height: 100%; background: repeating-linear-gradient(135deg, rgba(255,120,110,.28) 0 2px, transparent 2px 5px); }
.seg.mapped { border-radius: 1px 1px 0 0; }
.seg.l0 { height: 100%; background: #ffc857; }
.seg.l2 { height: 52%; background: rgba(255,200,87,.5); }
.seg.l4 { height: 24%; background: rgba(255,255,255,.28); }
.seg:hover { filter: brightness(1.35); }
.now { position: absolute; top: -3px; bottom: -3px; width: 2px; margin-left: -1px; border-radius: 1px; background: #fff;
  box-shadow: 0 0 0 1px rgba(0,0,0,.5); pointer-events: none; }
.foot { display: flex; justify-content: space-between; gap: 8px; margin-top: 4px; font-size: 11px; color: #aaa;
  font-variant-numeric: tabular-nums; }
.foot .st { color: #d6d6d6; }
@media (prefers-reduced-motion: reduce) { .dot { transition: none; } }
`;

export class Badge {
  private host: HTMLDivElement;
  private root: ShadowRoot;
  private el: Record<string, HTMLElement> = {};
  private open = false;
  private lingerTimer: ReturnType<typeof setTimeout> | undefined;
  private lastView: BadgeView | null = null;
  private timelineKey = '';
  private goalMode: GoalCardView['mode'] = 'hidden';
  /** The map last drawn (duration and playhead), for keyboard seeking. */
  private timeline: GoalTimeline | null = null;
  /** Index of the map region under the pointer, or -1. */
  private hovered = -1;

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
       <div class="card" data-k="card" role="group" aria-label="ViewPace">
        <div class="tl" data-k="tl" hidden>
          <div class="goal" data-k="goal">
            <button class="gchip" data-k="gchip" hidden>🎯 Set a viewing goal</button>
            <form class="gentry" data-k="gentry" hidden>
              <div class="ghead"><label class="gq" for="vp-goal">🎯 What do you want to get from this video?</label><button type="button" class="gclose" data-k="gclose" aria-label="Close the goal editor" title="Close (keeps the current goal)">✕</button></div>
              <div class="grow"><input id="vp-goal" data-k="ginput" maxlength="300" autocomplete="off" placeholder="Enter a viewing goal…" /><button class="gstart" type="submit">Start</button></div>
              <button class="gprev" type="button" data-k="gprev" hidden></button>
              <div class="gmsg" data-k="gmsg" role="status" hidden></div>
              <div class="gacts"><button type="button" data-k="gcancel">Cancel</button><button type="button" data-k="gstop" hidden>Stop Goal Mode</button></div>
            </form>
            <div class="gsaved" data-k="gsaved" hidden><span class="gtext" data-k="gsavedtext" role="button" tabindex="0" aria-label="Edit viewing goal"></span><button class="gresume" data-k="gresume">Resume</button><button class="gedit" data-k="gsavededit" aria-label="Edit viewing goal" title="Edit goal">✎</button></div>
            <div class="gline" data-k="gline" hidden><span class="gtext" data-k="gtext" role="button" tabindex="0" aria-label="Edit viewing goal"></span><button class="gedit" data-k="gedit" aria-label="Edit viewing goal" title="Edit goal">✎</button></div>
          </div>
          <div class="map" data-k="map">
          <div class="bar" data-k="bar" role="slider" tabindex="0" aria-valuemin="0">
            <span class="now" data-k="now"></span>
          </div>
          <div class="foot"><span data-k="tlStart">0:00</span><span class="st" data-k="tlStatus"></span><span data-k="tlEnd"></span></div>
          </div>
          <div class="tip" data-k="tip" hidden><div class="tr" data-k="tipRange"></div><div data-k="tipTopics"></div><div class="td" data-k="tipDetail"></div></div>
        </div>
        <button class="pill" data-k="pill" aria-expanded="false" aria-label="ViewPace: current speed. Show speed feedback">
          <span class="track" aria-hidden="true"><span class="dot" data-k="dot"></span></span>
          <span class="rate" data-k="rate"></span>
          <span class="line" data-k="line" hidden></span>
        </button>
        <div class="panel" data-k="panel" hidden>
          <p class="q" data-k="q">How's the speed?</p>
          <div class="fb" data-k="fb">
            <button data-f="too_slow">Too slow</button>
            <button data-f="good">Just right</button>
            <button data-f="too_fast">Too fast</button>
          </div>
          <p class="ack" data-k="ack" aria-live="polite"></p>
          <button class="secondary" data-k="toggle"></button>
        </div>
        <button class="resume" data-k="resume" hidden>Resume ViewPace</button>
       </div>
      </div>`;
    this.root.querySelectorAll<HTMLElement>('[data-k]').forEach((e) => (this.el[e.dataset.k!] = e));

    // Keep clicks and keys from reaching the YouTube player (which would pause or seek).
    for (const type of ['click', 'dblclick', 'mousedown', 'keydown', 'keyup', 'keypress']) {
      this.host.addEventListener(type, (e) => e.stopPropagation());
    }
    this.root.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const bar = t.closest<HTMLElement>('[data-k="bar"]');
      if (bar && this.timeline) {
        // Click or tap on the Goal Map: jump there (hover never seeks).
        const r = bar.getBoundingClientRect();
        const time = seekFromPointer(e.type, (e as MouseEvent).clientX, r.left, r.width, this.timeline.duration);
        if (time !== null) handlers.onSeek(time);
        return;
      }
      const f = t.closest<HTMLElement>('[data-f]')?.dataset.f;
      if (f) {
        handlers.onFeedback(f as Feedback);
        // Answered: show the thank-you briefly, then fold the card back to compact.
        clearTimeout(this.lingerTimer);
        this.lingerTimer = setTimeout(() => this.setOpen(false), FEEDBACK_LINGER_MS);
        return;
      }
      const k = t.closest<HTMLElement>('[data-k]')?.dataset.k;
      // The goal row (or ✎) opens the editor; ✕ / Cancel close it. Closing never stops or changes the goal.
      if (k === 'gchip' || k === 'gedit' || k === 'gtext' || k === 'gsavedtext' || k === 'gsavededit') return handlers.onGoalEditing(true);
      if (k === 'gresume') return handlers.onGoalResume();
      if (k === 'gcancel' || k === 'gclose') return handlers.onGoalEditing(false);
      if (k === 'gstop') return handlers.onGoalStop();
      if (k === 'gprev') {
        // Reuse the previous goal: fill it in; the viewer still presses Start.
        const input = this.el.ginput as HTMLInputElement;
        input.value = this.el.gprev!.dataset.goal ?? '';
        input.focus();
        return;
      }
      if (k === 'pill') this.setOpen(!this.open);
      else if (k === 'toggle') {
        handlers.onToggleEnabled();
        this.setOpen(false);
      } else if (k === 'resume') handlers.onResume();
    });
    // Hover shows what a part is about; it never seeks (only a click does).
    this.root.addEventListener('mouseover', (e) => {
      const seg = (e.target as HTMLElement).closest<HTMLElement>('.seg');
      this.showTip(seg ? Number(seg.dataset.i) : -1);
    });
    this.el.bar!.addEventListener('mouseleave', () => this.showTip(-1));
    this.el.gentry!.addEventListener('submit', (e) => {
      e.preventDefault(); // Enter or Start
      handlers.onGoalStart((this.el.ginput as HTMLInputElement).value);
    });
    this.root.addEventListener('keydown', (e) => {
      const key = (e as KeyboardEvent).key;
      if (key === 'Escape' && this.goalMode === 'entry') handlers.onGoalEditing(false);
      const tk = (e.target as HTMLElement).dataset?.k;
      if ((key === 'Enter' || key === ' ') && (tk === 'gtext' || tk === 'gsavedtext')) {
        e.preventDefault();
        handlers.onGoalEditing(true);
      }
      if (key === 'Escape') this.setOpen(false);
      if ((e.target as HTMLElement).dataset?.k === 'bar' && this.timeline) {
        const time = seekFromKey(key, this.timeline.position, this.timeline.duration);
        if (time !== null) {
          e.preventDefault();
          handlers.onSeek(time);
        }
      }
    });
  }

  private setOpen(open: boolean): void {
    clearTimeout(this.lingerTimer);
    this.open = open;
    this.el.pill!.setAttribute('aria-expanded', String(open));
    this.syncOpen();
    this.applyLayout();
  }

  /** Stay visible while the panel is open or a goal is being typed, even if YouTube hides its controls. */
  private syncOpen(): void {
    this.host.toggleAttribute('data-open', this.open || this.goalMode === 'entry');
  }

  /** The goal card above the map. The input's text is only set when it opens, never while typing. */
  private renderGoal(v: GoalCardView): void {
    const was = this.goalMode;
    this.goalMode = v.mode;
    this.el.goal!.hidden = v.mode === 'hidden';
    this.el.gchip!.hidden = v.mode !== 'chip';
    this.el.gentry!.hidden = v.mode !== 'entry';
    this.el.gline!.hidden = v.mode !== 'active';
    this.el.gsaved!.hidden = v.mode !== 'saved';
    if (v.mode === 'saved') {
      const text = `🎯 ${v.goal}`;
      if (this.el.gsavedtext!.textContent !== text) this.el.gsavedtext!.textContent = text;
      this.el.gsavedtext!.title = v.goal;
    }
    if (v.mode === 'active') {
      const text = `🎯 ${v.goal}`;
      if (this.el.gtext!.textContent !== text) this.el.gtext!.textContent = text;
      this.el.gtext!.title = v.goal;
    }
    if (v.mode === 'entry') {
      const input = this.el.ginput as HTMLInputElement;
      if (was !== 'entry') {
        input.value = v.value;
        input.focus();
      }
      const prev = this.el.gprev!;
      prev.hidden = !v.suggestion;
      prev.dataset.goal = v.suggestion ?? '';
      prev.textContent = v.suggestion ? `Previous: ${v.suggestion}` : '';
      prev.title = v.suggestion ?? '';
      this.el.gmsg!.hidden = !v.message;
      this.el.gmsg!.textContent = v.message ?? '';
      this.el.gstop!.hidden = !v.canStop;
    }
    if (was !== v.mode) this.syncOpen();
  }

  remove(): void {
    this.host.remove();
    document.getElementById('autospeed-badge-style')?.remove();
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

    if (v.state === 'off') set('rate', 'ViewPace off');
    else if (v.state === 'paused-by-user') set('rate', `Paused: you chose ${formatRate(v.rate)}`);
    else set('rate', formatRate(v.rate));

    this.el.line!.hidden = !v.line;
    set('line', v.line ?? '');
    set('ack', v.ack ?? '');
    // Rating only makes sense while ViewPace is choosing the speed.
    const rating = v.state === 'active';
    this.el.q!.hidden = !rating;
    this.el.fb!.hidden = !rating;
    this.el.ack!.hidden = !rating || !v.ack;
    set('toggle', v.state === 'off' ? 'Turn on ViewPace' : 'Turn off ViewPace');
    this.host.toggleAttribute('data-flash', v.flash || v.state === 'paused-by-user');
    this.renderGoal(v.goalCard);
    this.renderTimeline(v.timeline);
    this.lastView = v;
    this.applyLayout();
  }

  /** One card: show only the sections that have something to say. */
  private applyLayout(): void {
    if (!this.lastView) return;
    const layout = cardLayout(this.lastView, this.open);
    this.el.tl!.hidden = !layout.goal && !layout.map;
    this.el.map!.hidden = !layout.map;
    this.el.panel!.hidden = !layout.feedback;
    this.el.resume!.hidden = !layout.resume;
    this.el.card!.classList.toggle('wide', layout.wide);
  }

  /** Show the hover card for region `i` of the current map, above that part (or hide it for -1). */
  private showTip(i: number): void {
    const seg = i >= 0 ? this.timeline?.regions[i] : undefined;
    const tip = this.el.tip!;
    this.hovered = seg ? i : -1;
    if (!seg || !this.timeline) {
      tip.hidden = true;
      return;
    }
    const t = regionTooltip(seg);
    this.el.tipRange!.textContent = t.range;
    const line = (cls: string, text: string) => {
      const d = document.createElement('div');
      d.className = cls;
      d.textContent = text;
      return d;
    };
    this.el.tipTopics!.replaceChildren(...t.topics.map((x) => line('tt', x)), ...(t.more ? [line('more', `+${t.more} more`)] : []));
    this.el.tipDetail!.textContent = t.detail;
    tip.hidden = false;
    // Centre the card on the part, kept inside the map's box.
    const bar = this.el.bar!;
    const box = this.el.tl!;
    const mid = bar.offsetLeft + (((seg.start + seg.end) / 2) / this.timeline.duration) * bar.offsetWidth;
    tip.style.left = `${Math.max(0, Math.min(box.clientWidth - tip.offsetWidth, mid - tip.offsetWidth / 2))}px`;
  }

  /** Segments are rebuilt only when the map changes; the playhead marker moves every update. */
  private renderTimeline(tl: GoalTimeline | null): void {
    this.timeline = tl && tl.duration > 0 ? tl : null;
    if (!tl || tl.duration <= 0) {
      this.timelineKey = '';
      this.showTip(-1);
      return;
    }
    const pct = (t: number) => `${((t / tl.duration) * 100).toFixed(3)}%`;
    const key = `${tl.duration}|${tl.regions.map((r) => `${r.start},${r.end},${r.state},${r.tier ?? ''},${r.label ?? ''},${r.minRate ?? ''}-${r.maxRate ?? ''},${r.topics.join('/')}`).join(';')}`;
    if (key !== this.timelineKey) {
      this.timelineKey = key;
      const bar = this.el.bar!;
      // Drawn by region, in three visual tiers (display only; playback keeps every block's own speed).
      const segs = tl.regions.map((s, i) => {
        const e = document.createElement('span');
        e.className = `seg ${s.state}` + (s.state === 'mapped' ? ` ${TIER_CLASS[s.tier ?? VISUAL_TIERS - 1]}` : '');
        e.style.left = pct(s.start);
        e.style.width = pct(s.end - s.start);
        e.dataset.i = String(i);
        return e;
      });
      bar.replaceChildren(...segs, this.el.now!);
      this.showTip(this.hovered); // a part that was just analyzed shows its topic straight away
    }
    this.el.now!.style.left = pct(tl.position);
    const done = Math.floor(tl.progress * 100);
    const status = tl.mapping ? `Mapping… ${done}%` : 'Goal Map';
    const set = (k: string, text: string) => {
      const e = this.el[k];
      if (e && e.textContent !== text) e.textContent = text;
    };
    set('tlStatus', status);
    set('tlEnd', timelineClock(tl.duration));
    const bar = this.el.bar!;
    bar.setAttribute('aria-label', `Goal Map, ${done}% analyzed. Click or use the arrow keys to jump in the video.`);
    bar.setAttribute('aria-valuemax', String(Math.round(tl.duration)));
    bar.setAttribute('aria-valuenow', String(Math.round(tl.position)));
    bar.setAttribute('aria-valuetext', `${timelineClock(tl.position)} of ${timelineClock(tl.duration)}`);
  }
}

export function formatRate(r: number): string {
  return `${Number(r.toFixed(2))}×`;
}
