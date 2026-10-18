/**
 * Evaluation-only: product-level Goal Mode smoke test on a real YouTube video, driving the REAL
 * extension in the manually launched test Chrome (see README: Chrome must be started by hand with
 * --remote-debugging-port, the extension installed from a fresh path, Gemini Nano available).
 *
 * It acts like a user: types the goal into the in-page card, clicks Start / ✎ / Stop / Resume and
 * the Goal Map, reads the card's (open) shadow DOM, video.currentTime / playbackRate, the content
 * script's goal:status (via an extension page) and the debug overlay's per-block list. It changes
 * no production code.
 *
 *   npx esbuild eval/goal-mode/smoke-test.ts --bundle --platform=node --format=esm --outfile=/tmp/smoke.mjs
 *   EVAL_EXT_ID=<id> [EVAL_PORT=9333] [SMOKE_OUT=eval-results/goal-mode-smoke] node /tmp/smoke.mjs
 *
 * The extension page `check.html` (any blank HTML page added to the installed copy) is used to
 * reach chrome.storage and the tab's content script.
 */
import { mkdirSync, writeFileSync } from 'node:fs';

const PORT = process.env.EVAL_PORT ?? '9333';
const EXT = process.env.EVAL_EXT_ID;
if (!EXT) throw new Error('set EVAL_EXT_ID');
const VIDEO = 'zjkBMFhNj_g';
const URL_ = `https://www.youtube.com/watch?v=${VIDEO}`;
const GOAL_A = 'Understand how LLMs are trained and turned into assistants.';
const GOAL_B = 'Understand the security risks of LLMs, especially jailbreaks and prompt injection.';
const OUT = `${process.env.SMOKE_OUT ?? 'eval-results/goal-mode-smoke'}/${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`;
mkdirSync(OUT, { recursive: true });

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const t0 = Date.now();
const now = () => (Date.now() - t0) / 1000;
const log = (...a: unknown[]) => console.log(`[${now().toFixed(1).padStart(6)}s]`, ...a);

// ---------- DevTools protocol ----------
interface Target {
  id: string;
  url: string;
  type: string;
  webSocketDebuggerUrl: string;
}
class Cdp {
  private ws!: WebSocket;
  private id = 0;
  private pending = new Map<number, (m: { result?: any; error?: any }) => void>();
  static async open(match: (t: Target) => boolean, create?: string): Promise<Cdp> {
    const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as Target[];
    let t = list.find((x) => x.type === 'page' && match(x));
    if (!t && create) {
      t = (await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(create)}`, { method: 'PUT' })).json()) as Target;
      await sleep(1500);
    }
    if (!t) throw new Error('page not found');
    const c = new Cdp();
    c.ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r, j) => {
      c.ws.onopen = r;
      c.ws.onerror = j;
    });
    c.ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id && c.pending.has(m.id)) {
        c.pending.get(m.id)!(m);
        c.pending.delete(m.id);
      }
    };
    return c;
  }
  send(method: string, params: object = {}): Promise<any> {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, (m) => (m.error ? rej(new Error(`${method}: ${JSON.stringify(m.error)}`)) : res(m.result)));
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval<T>(expression: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 400)}`);
    return r.result.value as T;
  }
  close(): void {
    this.ws.close();
  }
}

// ---------- in-page helpers (YouTube main world; the ViewPace card is an open shadow root) ----------
const HELPERS = `
window.__vp = {
  sr: () => document.getElementById('autospeed-badge')?.shadowRoot ?? null,
  video: () => document.querySelector('#movie_player video.html5-main-video') || document.querySelector('#movie_player video'),
  vis: (el) => !!el && !el.hidden && el.closest('[hidden]') === null,
  state() {
    const sr = this.sr(); const v = this.video(); const q = (k) => sr?.querySelector('[data-k="' + k + '"]');
    const mode = !sr ? 'none' : this.vis(q('gentry')) ? 'entry' : this.vis(q('gsaved')) ? 'saved' : this.vis(q('gline')) ? 'active' : this.vis(q('gchip')) ? 'chip' : 'hidden';
    return {
      t: v ? v.currentTime : null, rate: v ? v.playbackRate : null, paused: v ? v.paused : null, duration: v ? v.duration : null,
      ad: document.getElementById('movie_player')?.classList.contains('ad-showing') ?? false,
      mode, goalText: (q('gline') && this.vis(q('gline')) ? q('gtext')?.textContent : this.vis(q('gsaved')) ? q('gsavedtext')?.textContent : null) ?? null,
      mapVisible: this.vis(q('map')), status: q('tlStatus')?.textContent ?? null, note: this.vis(q('gnote')) ? q('gnote').textContent : null,
      pill: (q('rate')?.textContent ?? '') + (this.vis(q('line')) ? ' · ' + q('line').textContent : ''),
      segs: sr ? [...sr.querySelectorAll('.seg')].map((e) => ({ cls: e.className.replace('seg ', ''), left: parseFloat(e.style.left), width: parseFloat(e.style.width), i: Number(e.dataset.i) })) : [],
    };
  },
  click(k) { const el = this.sr()?.querySelector('[data-k="' + k + '"]'); if (!el) return false; el.click(); return true; },
  submitGoal(text) { const sr = this.sr(); const input = sr.querySelector('#vp-goal'); input.value = text; sr.querySelector('form').requestSubmit(); return true; },
  clickMap(fraction) { const bar = this.sr().querySelector('[data-k="bar"]'); const r = bar.getBoundingClientRect(); const x = r.left + fraction * r.width; bar.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, clientX: x, clientY: r.top + r.height / 2 })); return { x, width: r.width }; },
  tooltip(i) {
    const sr = this.sr(); const seg = sr.querySelector('.seg[data-i="' + i + '"]'); if (!seg) return null;
    seg.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, composed: true }));
    const tip = sr.querySelector('[data-k="tip"]'); if (tip.hidden) return null;
    return { range: sr.querySelector('[data-k="tipRange"]').textContent, topics: [...sr.querySelector('[data-k="tipTopics"]').children].map((c) => c.textContent), detail: sr.querySelector('[data-k="tipDetail"]').textContent };
  },
  leaveMap() { this.sr()?.querySelector('[data-k="bar"]')?.dispatchEvent(new MouseEvent('mouseleave')); },
  pause() { const v = this.video(); if (v && !v.paused) v.pause(); return true; },
  play() { const v = this.video(); if (!v) return false; v.muted = true; if (v.paused) v.play().catch(() => {}); const skip = document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button-modern, .ytp-ad-skip-button'); if (skip) skip.click(); return true; },
  skipRect() { const b = document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button-modern, .ytp-ad-skip-button'); if (!b) return null; const r = b.getBoundingClientRect(); return r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; },
  playerRect() { const r = document.getElementById('movie_player').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; },
  overlayBlocks() {
    const sr = document.getElementById('autospeed-overlay')?.shadowRoot; if (!sr) return null;
    return [...sr.querySelectorAll('li.block')].map((li) => { const [range, rate, text] = [...li.children].map((c) => c.textContent); return { range, rate, text }; });
  },
};
true`;

// ---------- the run ----------
type Check = { name: string; pass: boolean; detail: string };
const checks: Check[] = [];
const check = (name: string, pass: boolean, detail: string) => {
  checks.push({ name, pass, detail });
  log(pass ? 'PASS' : 'FAIL', name, '-', detail);
};
const timings: Record<string, Record<string, number | string | null>> = {};
const shots: { name: string; file: string }[] = [];
const suspicious: string[] = [];

let yt: Cdp;
let ext: Cdp;
/** Run `expr` against the page helpers, installing them first if the page has reloaded since. */
const vp = <T>(expr: string) => yt.eval<T>(`(() => { if (!window.__vp) { ${HELPERS} } return ${expr}; })()`);
type State = { t: number; rate: number; paused: boolean; duration: number; ad: boolean; mode: string; goalText: string | null; mapVisible: boolean; status: string | null; note: string | null; pill: string; segs: { cls: string; left: number; width: number; i: number }[] };
const state = () => vp<State>('__vp.state()');
/** goal:status from the tab's content script, via the extension page (no tabs permission needed: ask every tab). */
const goalStatus = () =>
  ext.eval<{ phase: string; goal: string; rated: number; total: number; failed: number; message: string } | null | 'no-tab'>(`(async () => {
    for (const tab of await chrome.tabs.query({})) {
      try { const s = await chrome.tabs.sendMessage(tab.id, { kind: 'tab:status' }); if (s && s.onVideo) return await chrome.tabs.sendMessage(tab.id, { kind: 'goal:status' }); } catch {}
    }
    return 'no-tab';
  })()`);
const savedGoals = () => ext.eval<{ byVideo: Record<string, { goal: string; at: number }>; last: unknown } | null>(`chrome.storage.local.get('autospeed.goals').then((g) => g['autospeed.goals'] ?? null)`);
const setSetting = (patch: object) =>
  ext.eval(`chrome.storage.local.get('autospeed.settings').then((g) => chrome.storage.local.set({ 'autospeed.settings': { ...(g['autospeed.settings'] ?? {}), ...${JSON.stringify(patch)} } }))`);

async function screenshot(name: string): Promise<void> {
  const r = await vp<{ x: number; y: number; w: number; h: number }>('__vp.playerRect()');
  // Wake YouTube's controls (the card follows their visibility), then capture the player.
  await yt.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x + r.w * 0.5, y: r.y + r.h * 0.5 });
  await yt.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x + r.w * 0.52, y: r.y + r.h * 0.55 });
  await sleep(400);
  const shot = await yt.send('Page.captureScreenshot', { format: 'png', clip: { x: r.x, y: r.y, width: r.w, height: r.h, scale: 1 } });
  const file = `${OUT}/${String(shots.length + 1).padStart(2, '0')}-${name}.png`;
  writeFileSync(file, Buffer.from(shot.data, 'base64'));
  shots.push({ name, file });
  log('screenshot', file);
}

async function waitFor<T>(what: string, fn: () => Promise<T | null | false | undefined>, timeoutS: number, everyMs = 300): Promise<T | null> {
  const end = Date.now() + timeoutS * 1000;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v as T;
    await sleep(everyMs);
  }
  log('timeout waiting for', what);
  return null;
}

let adsSeen = 0;
/**
 * Load the video and get it playing (muted) past any ads: YouTube ignores synthetic clicks on Skip,
 * so it gets a real (CDP) click once it's shown. Then give ViewPace a few seconds to capture the
 * captions (it only tries once the video itself plays) before the test touches Goal Mode.
 */
async function openVideo(): Promise<void> {
  await yt.send('Page.navigate', { url: URL_ });
  await sleep(4000);
  let sawAd = false;
  const ready = await waitFor(
    'video playing without an ad',
    async () => {
      await vp('__vp.play()');
      const s = await state();
      if (s.ad) {
        sawAd = true;
        const skip = await vp<{ x: number; y: number } | null>('__vp.skipRect()');
        if (skip) for (const type of ['mousePressed', 'mouseReleased']) await yt.send('Input.dispatchMouseEvent', { type, x: skip.x, y: skip.y, button: 'left', clickCount: 1 });
        return null;
      }
      return s.t !== null && !s.paused && s.t > 1 && s.mode !== 'none' ? s : null;
    },
    420,
    1000,
  );
  if (sawAd) adsSeen++;
  if (!ready) suspicious.push('Video did not reach ad-free playback within 7 min');
  await sleep(8000); // caption capture (ViewPace toggles CC briefly once the video plays)
}

/** Wait until the card offers Goal Mode (captions captured + Nano ready show the chip or saved row). */
async function waitForGoalEntry(): Promise<State | null> {
  return waitFor(
    'goal card',
    async () => {
      await vp('__vp.play()');
      const s = await state();
      return s.mode === 'chip' || s.mode === 'saved' || s.mode === 'active' ? s : null;
    },
    90,
    1000,
  );
}

/** Start a goal through the in-page card and time the progressive milestones. */
async function startGoal(label: string, goal: string, from: 'chip' | 'edit'): Promise<void> {
  const tm: Record<string, number | string | null> = {};
  timings[label] = tm;
  await vp(from === 'chip' ? `__vp.click('gchip')` : `__vp.click('gedit')`);
  await sleep(300);
  const submitAt = now();
  await vp(`__vp.submitGoal(${JSON.stringify(goal)})`);
  tm.submitted = 0;
  await sleep(500);
  await screenshot(`${label}-just-started`);
  let breakdownAt: number | null = null;
  let firstMapped: number | null = null;
  let firstTarget: number | null = null;
  let firstRateChange: number | null = null;
  let firstReady: { at: number; status: string } | null = null;
  const startRate = (await state()).rate;
  let partialShot = false;
  const end = Date.now() + 15 * 60 * 1000;
  while (Date.now() < end) {
    await vp('__vp.play()');
    const s = await state();
    const st = await goalStatus();
    const t = now() - submitAt;
    if (breakdownAt === null && st && st !== 'no-tab' && !/Reading your goal/.test(st.message)) breakdownAt = t;
    if (firstMapped === null && s.segs.some((x) => x.cls.startsWith('mapped'))) firstMapped = t;
    if (firstTarget === null && /· (Key|Important|Relevant|Low relevance|Not relevant)$/.test(s.pill)) firstTarget = t;
    if (firstRateChange === null && s.rate !== startRate) firstRateChange = t;
    if (firstReady === null && s.status?.startsWith('Ready through')) firstReady = { at: t, status: s.status };
    if (!partialShot && st && st !== 'no-tab' && st.total && st.rated / st.total > 0.3) {
      partialShot = true;
      await screenshot(`${label}-partially-mapped`);
    }
    if (st && st !== 'no-tab' && st.phase !== 'mapping') {
      tm.completeS = Number(t.toFixed(1));
      tm.phase = st.phase;
      tm.blocks = st.total;
      tm.failed = st.failed;
      break;
    }
    await sleep(500);
  }
  Object.assign(tm, {
    breakdownReadyS: breakdownAt && Number(breakdownAt.toFixed(1)),
    firstMappedBlockS: firstMapped && Number(firstMapped.toFixed(1)),
    firstGoalAwarePacingS: firstTarget && Number(firstTarget.toFixed(1)),
    firstSpeedChangeS: firstRateChange && Number(firstRateChange.toFixed(1)),
    firstReadyThroughS: firstReady && Number(firstReady.at.toFixed(1)),
    firstReadyThrough: firstReady?.status ?? null,
  });
  log(label, 'timings', tm);
}

/** Per-block results from the debug overlay (final ratings never change once made). */
async function readBlocks(): Promise<{ range: string; start: number; rate: number | null; relevance: number | null; attention: number | null; topic: string | null; status: string }[]> {
  await setSetting({ debugOverlay: true });
  const rows = await waitFor('debug overlay rows', async () => {
    const r = await vp<{ range: string; rate: string; text: string }[] | null>('__vp.overlayBlocks()');
    return r && r.length ? r : null;
  }, 20);
  await setSetting({ debugOverlay: false });
  await sleep(1500);
  const sec = (s: string) => s.split(':').reduce((a, b) => a * 60 + Number(b), 0);
  return (rows ?? []).map((r) => {
    const m = r.text.match(/^R(\d+) A(\d+) · (.*)$/);
    return {
      range: r.range,
      start: sec(r.range.split('–')[0]!),
      rate: r.rate ? Number(r.rate.replace('×', '')) : null,
      relevance: m ? Number(m[1]) : null,
      attention: m ? Number(m[2]) : null,
      topic: m ? m[3]! : null,
      status: m ? 'rated' : r.text,
    };
  });
}

/** Final displayed regions with their hover cards; waits (bounded) for region names to arrive. */
async function readRegions(): Promise<{ cls: string; left: number; width: number; tip: { range: string; topics: string[]; detail: string } | null }[]> {
  const read = async () => {
    const s = await state();
    const out = [];
    for (const seg of s.segs) out.push({ cls: seg.cls, left: seg.left, width: seg.width, tip: await vp<{ range: string; topics: string[]; detail: string } | null>(`__vp.tooltip(${seg.i})`) });
    await vp('__vp.leaveMap()');
    return out;
  };
  // Names come from one call after mapping; wait until every analyzed region shows a single line (or 90 s).
  const named = await waitFor('region names', async () => {
    const r = await read();
    const mapped = r.filter((x) => x.cls.startsWith('mapped'));
    return mapped.length && mapped.every((x) => x.tip && x.tip.topics.length === 1) ? r : null;
  }, 90, 3000);
  if (!named) suspicious.push('Region names did not all arrive within 90 s of completion (some regions still show topic lists)');
  return named ?? (await read());
}

async function main(): Promise<void> {
  ext = await Cdp.open((t) => t.url === `chrome-extension://${EXT}/check.html`, `chrome-extension://${EXT}/check.html`);
  const nano = await ext.eval<string>(`LanguageModel.availability({ expectedInputs: [{ type: 'text', languages: ['en'] }], expectedOutputs: [{ type: 'text', languages: ['en'] }] })`);
  check('Gemini Nano available in the test profile', nano === 'available', nano);
  if (nano !== 'available') return;
  // Clean slate for this video: no saved goal, normal pace, no debug overlay.
  await ext.eval(`chrome.storage.local.remove('autospeed.goals')`);
  await setSetting({ enabled: true, showOverlay: true, debugOverlay: false, profile: 'normal' });

  yt = await Cdp.open((t) => t.url.includes('youtube.com'), 'about:blank');
  await yt.send('Page.enable');
  await yt.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await openVideo();
  const entry = await waitForGoalEntry();
  check('Goal prompt shown on a video with no saved goal', entry?.mode === 'chip', `card: ${entry?.mode ?? 'missing'}`);
  if (!entry) return;

  // ---- Goal A: start, progressive milestones, playback stays usable ----
  await startGoal('goalA', GOAL_A, 'chip');
  const tA = timings.goalA!;
  check('Breakdown, first mapped block and first goal-aware pacing all happen before mapping completes', [tA.breakdownReadyS, tA.firstMappedBlockS, tA.firstGoalAwarePacingS].every((x) => typeof x === 'number' && x < Number(tA.completeS)), JSON.stringify(tA));
  check('Goal A mapping completed', tA.phase === 'ready', `phase ${tA.phase}, ${tA.blocks} blocks, ${tA.failed} failed, ${tA.completeS} s`);
  const afterA = await state();
  check('Playback kept running during mapping', !afterA.paused && afterA.t > (entry.t ?? 0) + 30, `t ${afterA.t?.toFixed(0)} s (was ${entry.t?.toFixed(0)} s)`);
  const blocksA = await readBlocks();
  check('Per-block results recorded for Goal A', blocksA.length > 0 && blocksA.every((b) => b.status === 'rated' || /not mapped/.test(b.status)), `${blocksA.length} blocks`);
  const regionsA = await readRegions();
  await screenshot('goalA-completed-map');
  // Tooltip open on the longest analyzed region.
  const longestA = regionsA.map((r, i) => ({ r, i })).filter((x) => x.r.cls.startsWith('mapped')).sort((a, b) => b.r.width - a.r.width)[0];
  if (longestA) {
    await vp(`__vp.tooltip(${longestA.i})`);
    await screenshot('goalA-tooltip-open');
    await vp('__vp.leaveMap()');
  }

  // ---- Seek to a mapped region through the Goal Map ----
  if (longestA) {
    const mid = (longestA.r.left + longestA.r.width / 2) / 100;
    const before = await state();
    await vp(`__vp.clickMap(${mid})`);
    await sleep(800);
    const after = await state();
    const expected = mid * before.duration;
    check('Goal Map click on a mapped region seeks there', Math.abs(after.t - expected) < 15, `expected ≈${expected.toFixed(0)} s, got ${after.t.toFixed(0)} s (map ~${(before.duration / 272).toFixed(0)} s per pixel)`);
  }

  // ---- Stop keeps the saved goal ----
  await vp(`__vp.click('gedit')`);
  await sleep(300);
  await vp(`__vp.click('gstop')`);
  await sleep(1500);
  const stopped = await state();
  const savedAfterStop = await savedGoals();
  const stStop = await goalStatus();
  check('Stop ends Goal Mode', stStop === null && !stopped.mapVisible, `goal:status ${JSON.stringify(stStop)}, map ${stopped.mapVisible}`);
  check('Stop keeps the saved goal (Resume shown)', stopped.mode === 'saved' && savedAfterStop?.byVideo?.[VIDEO]?.goal === GOAL_A, `card ${stopped.mode}, saved ${JSON.stringify(savedAfterStop?.byVideo?.[VIDEO]?.goal)}`);

  // ---- Resume that can't start: right after a reload, paused, before captions are captured ----
  await yt.send('Page.navigate', { url: URL_ });
  const early = await waitFor('saved card before playback', async () => {
    await vp('__vp.pause()');
    const s = await state();
    return s.mode === 'saved' ? s : null;
  }, 60, 200);
  if (early) {
    await vp('__vp.pause()');
    await vp(`__vp.click('gresume')`);
    await sleep(2500);
    const f = await state();
    const savedNow = await savedGoals();
    if (f.mapVisible) {
      check('Failed Resume gives visible feedback', true, 'not provoked: captions were already captured, so Resume started (nothing to check)');
      await vp(`__vp.click('gedit')`);
      await sleep(200);
      await vp(`__vp.click('gstop')`);
    } else {
      check('Failed Resume gives visible feedback', !!f.note && f.mode === 'saved', `card ${f.mode}, note "${f.note}"`);
      check('Failed Resume keeps the saved goal and does not pretend Goal Mode is on', savedNow?.byVideo?.[VIDEO]?.goal === GOAL_A && !f.mapVisible, `saved "${savedNow?.byVideo?.[VIDEO]?.goal}", map ${f.mapVisible}`);
      await screenshot('resume-failed-feedback');
    }
  } else suspicious.push('Could not catch the saved card before playback to provoke a failed Resume');

  // ---- Reload: saved goal shows with Resume; no mapping restarts ----
  await openVideo();
  const afterReload = await waitForGoalEntry();
  await sleep(15000); // give any (wrong) automatic restart time to show
  const r2 = await state();
  const stReload = await goalStatus();
  await screenshot('saved-inactive-after-reload');
  check('After reload the saved goal shows with Resume', r2.mode === 'saved' && (r2.goalText ?? '').includes(GOAL_A.slice(0, 30)), `card ${r2.mode} "${r2.goalText}"`);
  check('After reload mapping does NOT restart', stReload === null && !r2.mapVisible && r2.segs.length === 0, `goal:status ${JSON.stringify(stReload)}, segments ${r2.segs.length}`);
  if (!afterReload) return;

  // ---- Resume starts mapping; seeking into an unmapped part reprioritizes ----
  const resumeAt = now();
  await vp(`__vp.click('gresume')`);
  const resumed = await waitFor('mapping after Resume', async () => {
    const s = await state();
    return s.mapVisible && s.segs.some((x) => x.cls.startsWith('mapped')) ? s : null;
  }, 60, 300);
  check('Resume starts mapping', !!resumed, resumed ? `first mapped block ${(now() - resumeAt).toFixed(1)} s after Resume` : 'no mapped block within 60 s');
  if (resumed) check('A successful retry clears the failure message', !resumed.note, `note ${JSON.stringify(resumed.note)}`);
  if (resumed) {
    // Seek far ahead into what is still unmapped; the next blocks rated should be there.
    const s = await state();
    const target = 0.7;
    const covering = (st: State) => st.segs.find((x) => x.left <= target * 100 && x.left + x.width > target * 100);
    const wasUnmapped = covering(s)?.cls === 'pending';
    const clickAt = now();
    await vp(`__vp.clickMap(${target})`);
    await sleep(500);
    const seeked = await state();
    check('Goal Map click into an unmapped part seeks there', Math.abs(seeked.t - target * seeked.duration) < 15, `t ${seeked.t.toFixed(0)} s of ${seeked.duration.toFixed(0)}`);
    const got = await waitFor('reprioritized block', async () => {
      const st = await state();
      return covering(st)?.cls.startsWith('mapped') ? st : null;
    }, 60, 300);
    const gap = got ? got.segs.filter((x) => x.left > 20 && x.left + x.width < target * 100 - 2 && x.cls === 'pending').length : 0;
    check(
      'Seeking into an unmapped part makes it analyzed next',
      wasUnmapped && !!got,
      got ? `analyzed ${(now() - clickAt).toFixed(1)} s after the seek; ${gap} unmapped regions still left between 20% and the seek point (work jumped ahead)` : `not analyzed within 60 s (was unmapped: ${wasUnmapped})`,
    );
  }
  await screenshot('resumed-partially-mapped-after-seek');

  // ---- Goal B on the same video (edit + Start) ----
  await vp('__vp.video().currentTime = 5');
  await sleep(1000);
  await startGoal('goalB', GOAL_B, 'edit');
  const tB = timings.goalB!;
  check('Goal B mapping completed', tB.phase === 'ready', `phase ${tB.phase}, ${tB.blocks} blocks, ${tB.failed} failed, ${tB.completeS} s`);
  const savedB = await savedGoals();
  check('Editing the goal saves the new one for this video', savedB?.byVideo?.[VIDEO]?.goal === GOAL_B, JSON.stringify(savedB?.byVideo?.[VIDEO]?.goal));
  const blocksB = await readBlocks();
  const regionsB = await readRegions();
  await screenshot('goalB-completed-map');

  // ---- Map faithfulness: speeds follow the unchanged table; Key/Important blocks stay visible ----
  const expectedRate = (r: number, a: number) => (r >= 7 && a >= 7 ? 1 : r >= 7 ? 1.15 : r >= 5 ? 1.4 : r >= 3 ? 1.75 : 2);
  for (const [g, blocks, regions] of [['A', blocksA, regionsA], ['B', blocksB, regionsB]] as const) {
    const rated = blocks.filter((b) => b.relevance !== null);
    const wrong = rated.filter((b) => b.rate !== expectedRate(b.relevance!, b.attention!));
    check(`Goal ${g}: every block's speed matches the speed table`, wrong.length === 0, wrong.length ? wrong.map((b) => `${b.range} R${b.relevance} A${b.attention} → ${b.rate}`).join('; ') : `${rated.length} blocks`);
    const dur = blocks.length ? Math.max(...blocks.map((b) => b.start)) + 90 : 1;
    const total = (await state()).duration || dur;
    const regionAt = (t: number) => regions.find((r) => (t / total) * 100 >= r.left && (t / total) * 100 < r.left + r.width);
    const peaks = rated.filter((b) => (b.relevance ?? 0) >= 7);
    const hidden = peaks.filter((b) => {
      const [s0, e0] = b.range.split('–').map((x) => x.split(':').reduce((a, v) => a * 60 + Number(v), 0));
      const r = regionAt((s0! + e0!) / 2);
      return !r || !r.cls.includes('l0');
    });
    check(`Goal ${g}: Key and Important blocks are visible as slow on the map`, hidden.length === 0, hidden.length ? `drawn faster: ${hidden.map((b) => `${b.range} (${b.rate}×)`).join(', ')}` : `${peaks.length} Key/Important blocks, all in slow regions`);
  }
  // Long regions: names and the blocks behind them, for reading.
  const longRegions = (g: 'A' | 'B', blocks: typeof blocksA, regions: typeof regionsA) =>
    regions
      .filter((r) => r.tip && r.cls.startsWith('mapped') && r.width > 15)
      .map((r) => ({ goal: g, range: r.tip!.range, name: r.tip!.topics.join(' / '), detail: r.tip!.detail }));
  const longs = [...longRegions('A', blocksA, regionsA), ...longRegions('B', blocksB, regionsB)];
  for (const l of longs) log('long region', l);
  const secB = regionsB.filter((r) => r.cls.startsWith('mapped') && r.cls.includes('l0') && r.tip);
  check('Goal B: its security region is named for security', secB.some((r) => /secur|jailbreak|injection|attack|risk|vulnerab|safety/i.test(r.tip!.topics.join(' '))), secB.map((r) => `${r.tip!.range}: ${r.tip!.topics.join(' / ')}`).join('; ') || 'no slow region');

  // ---- A vs B ----
  const byStart = new Map(blocksB.map((b) => [b.start, b]));
  const pairs = blocksA.filter((a) => a.relevance !== null && byStart.get(a.start)?.relevance != null).map((a) => [a, byStart.get(a.start)!] as const);
  const diffRel = pairs.filter(([a, b]) => Math.abs(a.relevance! - b.relevance!) >= 3).length;
  const diffRate = pairs.filter(([a, b]) => a.rate !== b.rate).length;
  const high = (bs: typeof blocksA) => new Set(bs.filter((b) => (b.relevance ?? 0) >= 7).map((b) => b.start));
  const hA = high(blocksA);
  const hB = high(blocksB);
  const inter = [...hA].filter((x) => hB.has(x)).length;
  const jac = hA.size + hB.size - inter ? inter / (hA.size + hB.size - inter) : 0;
  check('Goal A and Goal B maps differ materially', pairs.length > 0 && diffRate / pairs.length > 0.3 && jac < 0.5, `${diffRate}/${pairs.length} blocks at a different speed, ${diffRel} differ by ≥3 in relevance, high-relevance overlap (Jaccard) ${jac.toFixed(2)}`);

  if (adsSeen) suspicious.push(`YouTube showed pre-roll ads on ${adsSeen} load(s); the test waited them out (ViewPace pauses during ads)`);
  const report = { video: URL_, goals: { A: GOAL_A, B: GOAL_B }, checks, timings, longRegions: longs, blocks: { A: blocksA, B: blocksB }, regions: { A: regionsA, B: regionsB }, comparison: { pairs: pairs.length, diffRate, diffRel, highA: hA.size, highB: hB.size, highJaccard: Number(jac.toFixed(2)) }, screenshots: shots, suspicious };
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 1));
  writeFileSync(`${OUT}/report.md`, markdown(report));
  log('report written to', OUT);
}

function markdown(r: any): string {
  const md: string[] = [`# Goal Mode smoke test`, '', `Video: ${r.video}  `, `Goal A: ${r.goals.A}  `, `Goal B: ${r.goals.B}`, ''];
  md.push('## Checks', '', '| | Check | Detail |', '|---|---|---|');
  for (const c of r.checks) md.push(`| ${c.pass ? 'PASS' : '**FAIL**'} | ${c.name} | ${String(c.detail).replace(/\|/g, '/')} |`);
  md.push('', '## Timings (seconds after Start)', '', '| | Goal A | Goal B |', '|---|---|---|');
  for (const k of ['breakdownReadyS', 'firstMappedBlockS', 'firstGoalAwarePacingS', 'firstSpeedChangeS', 'firstReadyThroughS', 'firstReadyThrough', 'completeS', 'blocks', 'failed'])
    md.push(`| ${k} | ${r.timings.goalA?.[k] ?? '–'} | ${r.timings.goalB?.[k] ?? '–'} |`);
  md.push('', '## Goal A vs Goal B', '', '```', JSON.stringify(r.comparison), '```', '');
  md.push('## Long regions and their names', '', ...(r.longRegions ?? []).map((l: any) => `- Goal ${l.goal} ${l.range}: **${l.name}** · ${l.detail}`), '');
  for (const g of ['A', 'B']) {
    md.push(`### Regions, Goal ${g}`, '');
    for (const x of r.regions[g]) md.push(`- ${x.tip ? `${x.tip.range} · ${x.tip.topics.join(' / ') || '—'} · ${x.tip.detail}` : x.cls}`);
    md.push('', `### Blocks, Goal ${g}`, '', '| Time | R | A | Speed | Topic |', '|---|---|---|---|---|');
    for (const b of r.blocks[g]) md.push(`| ${b.range} | ${b.relevance ?? '–'} | ${b.attention ?? '–'} | ${b.rate ?? '–'} | ${b.topic ?? b.status} |`);
    md.push('');
  }
  md.push('## Screenshots', '', ...r.screenshots.map((s: any) => `- ${s.name}: ${s.file.split('/').pop()}`), '', '## Suspicious', '', ...(r.suspicious.length ? r.suspicious.map((s: string) => `- ${s}`) : ['- none']));
  return md.join('\n') + '\n';
}

main()
  .catch((e) => {
    check('Smoke test ran to completion', false, e instanceof Error ? e.message : String(e));
    writeFileSync(`${OUT}/report.json`, JSON.stringify({ checks, timings, screenshots: shots, suspicious }, null, 1));
  })
  .finally(() => {
    yt?.close();
    ext?.close();
    const failed = checks.filter((c) => !c.pass).length;
    log(`done: ${checks.length - failed} passed, ${failed} failed`);
  });
