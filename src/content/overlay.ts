import type { Feedback } from '../shared/types';

/**
 * One row of the Goal Mode map (debug only): a section heading (labels only, no scores) or a
 * block with its own pacing decision. `status` 'pending'/'failed' = block not mapped.
 */
export type GoalMapRow =
  | { kind: 'section'; start: number; end: number; topic: string; current: boolean }
  | {
      kind: 'block';
      start: number;
      end: number;
      status: 'rated' | 'pending' | 'failed';
      topic?: string;
      relevance?: number;
      attention?: number;
      rate?: number;
      current: boolean;
    };

export interface OverlayView {
  enabled: boolean;
  mode: string;
  profile: string;
  rate: number;
  speech: string;
  ai: string;
  aiStatus: string;
  transcript: string;
  chunk: string;
  reason: string;
  notice: string | null;
  canResume: boolean;
  feedbackAck: string | null;
  /** Label for an action button under the AI row (e.g. model download), or null to hide it. */
  aiAction: string | null;
  /** Goal Mode map rows (debug), or null when Goal Mode is off. */
  goalMap: GoalMapRow[] | null;
  /** Goal Mode details for the current position (debug), or null when Goal Mode is off. */
  goalNow: string | null;
}

export interface OverlayHandlers {
  onFeedback(f: Feedback): void;
  onToggleEnabled(): void;
  onToggleMode(): void;
  onDownloadModel(): void;
  onResume(): void;
}

const CSS = `
:host { all: initial; }
[hidden] { display: none !important; }
.box { position: absolute; top: 12px; right: 12px; z-index: 70; width: 340px; max-width: calc(100% - 24px);
  font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color: #e8e8e8;
  background: rgba(15,15,15,.86); border: 1px solid rgba(255,255,255,.15); border-radius: 8px;
  padding: 8px 10px; box-sizing: border-box; pointer-events: auto; }
.box.collapsed .body { display: none; }
.head { display: flex; align-items: center; gap: 6px; }
.title { font-weight: 700; flex: 1; }
.rate { font-size: 16px; font-weight: 700; color: #7cf; }
.off .rate { color: #888; }
button { font: inherit; color: inherit; background: rgba(255,255,255,.1); border: 1px solid rgba(255,255,255,.2);
  border-radius: 4px; padding: 2px 6px; cursor: pointer; }
button:hover { background: rgba(255,255,255,.2); }
.row { display: grid; grid-template-columns: 82px minmax(0,1fr); gap: 6px; margin-top: 3px; }
.k { color: #999; }
.v { overflow-wrap: anywhere; }
.goalmap { margin-top: 6px; }
.goalmap summary { cursor: pointer; color: #999; }
.goalmap ol { list-style: none; margin: 4px 0 0; padding: 0; max-height: 180px; overflow-y: auto; }
.goalmap li { display: grid; grid-template-columns: 78px 40px minmax(0, 1fr); gap: 6px; padding: 1px 2px; border-radius: 3px; }
.goalmap li.block { padding-left: 10px; }
.goalmap li.section { margin-top: 4px; color: #ddd; font-weight: 700; grid-template-columns: 78px minmax(0, 1fr); }
.goalmap li.unmapped { color: #777; }
.goalnow { white-space: pre-line; }
.goalmap li.current { background: rgba(124, 204, 255, .18); }
.goalmap .scores { color: #7cf; }
.chunk { color: #bbb; max-height: 4.2em; overflow: hidden; }
.notice { margin-top: 6px; color: #fc6; }
.fb { display: flex; gap: 6px; margin-top: 8px; }
.fb button { flex: 1; }
.ack { color: #8d8; margin-top: 4px; min-height: 1.4em; }
`;

export class Overlay {
  private host: HTMLDivElement;
  private root: ShadowRoot;
  private els: Record<string, HTMLElement> = {};

  constructor(private handlers: OverlayHandlers) {
    this.host = document.createElement('div');
    this.host.id = 'autospeed-overlay';
    this.root = this.host.attachShadow({ mode: 'open' });
    this.root.innerHTML = `
      <style>${CSS}</style>
      <div class="box" part="box">
        <div class="head">
          <span class="title">ViewPace</span>
          <span class="rate" data-k="rate">–</span>
          <button data-a="toggle" title="Enable/disable (Alt+Shift+S)">On</button>
          <button data-a="collapse" title="Collapse">–</button>
        </div>
        <div class="body">
          <div class="row"><span class="k">mode</span><span class="v"><button data-a="mode" data-k="mode"></button> <span data-k="profile"></span></span></div>
          <div class="row"><span class="k">speech</span><span class="v" data-k="speech"></span></div>
          <div class="row"><span class="k">AI score</span><span class="v" data-k="ai"></span></div>
          <div class="row"><span class="k"></span><span class="v"><button data-a="download" hidden></button></span></div>
          <div class="row"><span class="k">Nano</span><span class="v" data-k="aiStatus"></span></div>
          <div class="row"><span class="k">transcript</span><span class="v" data-k="transcript"></span></div>
          <div class="row" data-k="goalNowRow" hidden><span class="k">goal</span><span class="v goalnow" data-k="goalNow"></span></div>
          <div class="row"><span class="k">reason</span><span class="v" data-k="reason"></span></div>
          <div class="row"><span class="k">chunk</span><span class="v chunk" data-k="chunk"></span></div>
          <div class="notice" data-k="notice" hidden></div>
          <details class="goalmap" data-k="goalmap" open hidden>
            <summary data-k="goalmapTitle">Goal map</summary>
            <ol data-k="goalmapList"></ol>
          </details>
          <button data-a="resume" hidden>Resume ViewPace</button>
          <div class="fb">
            <button data-a="too_slow">Too Slow</button>
            <button data-a="good">Good</button>
            <button data-a="too_fast">Too Fast</button>
          </div>
          <div class="ack" data-k="ack"></div>
        </div>
      </div>`;
    this.root.querySelectorAll<HTMLElement>('[data-k]').forEach((el) => (this.els[el.dataset.k!] = el));
    this.root.querySelectorAll<HTMLElement>('[data-a]').forEach((el) => (this.els['btn_' + el.dataset.a!] = el));

    // Keep clicks/keys from reaching the YouTube player (which would pause/seek).
    for (const type of ['click', 'dblclick', 'mousedown', 'keydown']) {
      this.host.addEventListener(type, (e) => e.stopPropagation());
    }
    this.root.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest<HTMLElement>('[data-a]')?.dataset.a;
      if (!a) return;
      if (a === 'collapse') this.root.querySelector('.box')!.classList.toggle('collapsed');
      else if (a === 'toggle') handlers.onToggleEnabled();
      else if (a === 'mode') handlers.onToggleMode();
      else if (a === 'resume') handlers.onResume();
      else if (a === 'download') handlers.onDownloadModel();
      else handlers.onFeedback(a as Feedback);
    });
  }

  /** (Re)attach inside the player so it also shows in fullscreen. */
  mount(): void {
    const player = document.getElementById('movie_player');
    if (player && this.host.parentElement !== player) player.appendChild(this.host);
  }

  remove(): void {
    this.host.remove();
  }

  setVisible(v: boolean): void {
    this.host.style.display = v ? '' : 'none';
  }

  private goalMapKey = '';

  /** Rebuilt only when the map (or the current row) changes, so it doesn't flicker every tick. */
  private renderGoalMap(rows: GoalMapRow[] | null): void {
    const box = this.els.goalmap!;
    box.hidden = !rows;
    if (!rows) {
      this.goalMapKey = '';
      return;
    }
    const key = JSON.stringify(rows);
    if (key === this.goalMapKey) return;
    this.goalMapKey = key;
    const time = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    const blocks = rows.filter((r) => r.kind === 'block');
    const rated = blocks.filter((r) => r.kind === 'block' && r.status === 'rated').length;
    const sections = rows.length - blocks.length;
    this.els.goalmapTitle!.textContent = `Goal map: ${rated}/${blocks.length} blocks paced, ${sections} sections (labels only)`;
    const list = this.els.goalmapList!;
    list.replaceChildren(
      ...rows.map((r) => {
        const li = document.createElement('li');
        const range = document.createElement('span');
        range.textContent = `${time(r.start)}–${time(r.end)}`;
        if (r.kind === 'section') {
          li.className = 'section';
          const topic = document.createElement('span');
          topic.textContent = `§ ${r.topic}`;
          li.append(range, topic);
          return li;
        }
        li.className = 'block' + (r.status !== 'rated' ? ' unmapped' : '') + (r.current ? ' current' : '');
        const rate = document.createElement('span');
        rate.className = 'scores';
        rate.textContent = r.status === 'rated' ? `${r.rate?.toFixed(2)}×` : '';
        const text = document.createElement('span');
        text.textContent =
          r.status === 'rated' ? `R${r.relevance} A${r.attention} · ${r.topic}` : r.status === 'failed' ? 'not mapped (failed)' : 'not mapped yet';
        li.append(range, rate, text);
        return li;
      }),
    );
    // Keep the current row visible by scrolling the list only (never the YouTube page).
    const cur = list.querySelector<HTMLElement>('.current');
    if (cur) list.scrollTop = Math.max(0, cur.offsetTop - list.offsetTop - list.clientHeight / 3);
  }

  update(v: OverlayView): void {
    this.mount();
    const set = (k: string, text: string) => {
      const el = this.els[k];
      if (el && el.textContent !== text) el.textContent = text;
    };
    this.root.querySelector('.box')!.classList.toggle('off', !v.enabled);
    set('rate', `${v.rate.toFixed(2)}×`);
    set('btn_toggle', v.enabled ? 'On' : 'Off');
    set('mode', v.mode === 'ai' ? 'AI Adaptive' : 'Baseline');
    set('profile', v.profile);
    set('speech', v.speech);
    set('ai', v.ai);
    set('aiStatus', v.aiStatus);
    set('transcript', v.transcript);
    set('reason', v.reason);
    set('chunk', v.chunk || '—');
    set('ack', v.feedbackAck ?? '');
    const notice = this.els.notice!;
    notice.hidden = !v.notice;
    set('notice', v.notice ?? '');
    this.els.btn_resume!.hidden = !v.canResume;
    this.renderGoalMap(v.goalMap);
    this.els.goalNowRow!.hidden = !v.goalNow;
    set('goalNow', v.goalNow ?? '');
    const dl = this.els.btn_download!;
    dl.hidden = !v.aiAction;
    dl.parentElement!.parentElement!.hidden = !v.aiAction;
    set('btn_download', v.aiAction ?? '');
  }
}
