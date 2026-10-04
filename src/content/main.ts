import { appendDecision, attachFeedback } from '../shared/log';
import { PAGE_TAG, type ContentToPage, type PageToContent } from '../shared/messages';
import { loadSettings, onSettingsChanged, saveSettings, type Settings } from '../shared/settings';
import type { AiAvailability, DecisionLogEntry, Feedback, SpeechFeatures, TimedWord } from '../shared/types';
import { LANGUAGE_OPTIONS, getLanguageModel } from '../shared/nano';
import { ComplexityCache, DisabledProvider, NanoProvider, type ComplexityProvider } from './ai';
import type { ChunkContext } from '../shared/complexity-prompt';
import { computeTarget, initialState, step, videoMean, type ControllerState } from './controller';
import { computeFeatures, windowText } from './features';
import { Overlay } from './overlay';
import { TranscriptStore } from './transcript';

const TICK_MS = 1000;
const WINDOW_SEC = 20; // analysis window length (media seconds)
const CHUNK_STEP = 10; // AI chunk grid step (media seconds)
const USER_INPUT_GRACE_MS = 1500; // a ratechange this soon after user input on speed controls = manual override
const SETTLE_MS = 2000; // ignore rate changes YouTube makes right after a video loads

// ---------- state ----------
let settings: Settings;
const store = new TranscriptStore();
const nano = new NanoProvider();
const disabled = new DisabledProvider();
const ai = new ComplexityCache(disabled);
let aiStatus: AiAvailability = 'disabled';

let video: HTMLVideoElement | null = null;
let videoId: string | null = null;
let videoChangedAt = 0;
let ctrl: ControllerState = initialState(1);
let controlling = false; // we have set the rate at least once for this video
let rateBeforeControl = 1;
let lastApplied: number | null = null;
let manualOverride = false;
let lastUserSpeedInput = -Infinity;
let lastReason = '';
let lastTargetRate = 1;
let lastDecisionId: string | null = null;
let feedbackAck: string | null = null;
const captionAttempted = new Set<string>();
let captionNotice: string | null = null;

const overlay = new Overlay({
  onFeedback: (f) => void giveFeedback(f),
  onToggleEnabled: () => void saveSettings({ enabled: !settings.enabled }),
  onToggleMode: () => void saveSettings({ mode: settings.mode === 'ai' ? 'baseline' : 'ai' }),
  onDownloadModel: () => void downloadModel(),
  onResume: () => {
    manualOverride = false;
    ctrl = initialState(video?.playbackRate ?? 1);
  },
});

// ---------- helpers ----------
function currentVideoId(): string | null {
  if (location.pathname !== '/watch') return null;
  return new URLSearchParams(location.search).get('v');
}

function findVideo(): HTMLVideoElement | null {
  return document.querySelector<HTMLVideoElement>('#movie_player video.html5-main-video') ?? document.querySelector('#movie_player video');
}

function adShowing(): boolean {
  return document.getElementById('movie_player')?.classList.contains('ad-showing') ?? false;
}

function providerFor(s: Settings): ComplexityProvider {
  return s.mode === 'ai' ? nano : disabled;
}

async function refreshAiStatus(): Promise<void> {
  const prev = aiStatus;
  aiStatus = await nano.status(); // shown in both modes so Baseline users can see whether AI mode would work
  if (aiStatus === 'available' && prev !== 'available') ai.clear(); // drop failures from before the model was ready
}

/** Only ask for scores once the model is actually usable; otherwise behave like Baseline. */
function aiReady(): boolean {
  return settings.mode === 'ai' && aiStatus === 'available';
}

let downloadProgress: string | null = null;

/**
 * Start the Gemini Nano download from an overlay click (a user gesture in this page). The model
 * is shared browser-wide, so downloading it here also makes it available to the offscreen doc.
 */
async function downloadModel(): Promise<void> {
  const LM = getLanguageModel();
  if (!LM) {
    downloadProgress = 'Prompt API not available here: use the AutoSpeed popup → Download model';
    return;
  }
  downloadProgress = 'starting download…';
  try {
    const session = await LM.create({
      ...LANGUAGE_OPTIONS,
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          downloadProgress = `downloading ${Math.round(((e as ProgressEvent).loaded ?? 0) * 100)}%`;
        });
      },
    });
    session.destroy();
    downloadProgress = null;
  } catch (e) {
    downloadProgress = `download failed (${e instanceof Error ? e.message : String(e)}): try the AutoSpeed popup`;
  }
  void refreshAiStatus();
}

function applyRate(rate: number): void {
  if (!video) return;
  if (!controlling) {
    rateBeforeControl = video.playbackRate;
    controlling = true;
  }
  lastApplied = rate;
  video.playbackRate = rate;
}

function releaseControl(): void {
  if (video && controlling && !manualOverride) {
    lastApplied = rateBeforeControl;
    video.playbackRate = rateBeforeControl;
  }
  controlling = false;
  ctrl = initialState(video?.playbackRate ?? 1);
}

async function giveFeedback(f: Feedback): Promise<void> {
  if (!lastDecisionId) {
    feedbackAck = 'No decision logged yet';
    return;
  }
  const ok = await attachFeedback(lastDecisionId, f);
  const label = { too_slow: 'Too Slow', good: 'Good', too_fast: 'Too Fast' }[f];
  feedbackAck = ok ? `Logged "${label}" @ ${lastDecisionId.slice(-6)}` : 'Could not log feedback';
}

// ---------- page hook bridge ----------
window.addEventListener('message', (ev: MessageEvent<PageToContent>) => {
  if (ev.source !== window || !ev.data || ev.data[PAGE_TAG] !== true) return;
  const msg = ev.data;
  if (msg.type === 'timedtext') {
    const t = store.ingestTimedtext(msg.url, msg.body);
    if (t && t.videoId === videoId) {
      ai.clear();
      captionNotice = null;
    }
  } else if (msg.type === 'transcript-panel') {
    const id = currentVideoId();
    if (id) store.ingestTranscriptPanel(id, msg.body);
  }
});
window.postMessage({ [PAGE_TAG]: true, type: 'replay' } satisfies ContentToPage, location.origin);

// ---------- live caption DOM fallback ----------
let lastCaptionText = '';
const captionObserver = new MutationObserver(() => {
  if (!video || !videoId) return;
  const segs = document.querySelectorAll('#movie_player .ytp-caption-segment');
  const text = Array.from(segs, (s) => s.textContent ?? '').join(' ');
  if (text === lastCaptionText) return;
  store.observeLive(videoId, lastCaptionText, text, video.currentTime);
  lastCaptionText = text;
});

// ---------- making the player fetch the caption track ----------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The only reliable way to get the timed track is to let the player request it. If CC is off,
 * briefly turn it on (the player fetches the whole track), then restore the user's choice.
 */
async function ensureCaptionTrack(id: string): Promise<void> {
  if (captionAttempted.has(id) || store.track(id)) return;
  captionAttempted.add(id);
  const btn = document.querySelector<HTMLButtonElement>('#movie_player .ytp-subtitles-button');
  if (!btn || btn.offsetParent === null || btn.getAttribute('aria-disabled') === 'true') {
    captionNotice = 'This video has no captions';
    return;
  }
  const wasOn = btn.getAttribute('aria-pressed') === 'true';
  if (!wasOn && !settings.autoEnableCaptions) {
    captionNotice = 'Turn on CC once to load the transcript';
    return;
  }
  captionNotice = 'Loading caption track…';
  if (wasOn) {
    btn.click(); // off
    await sleep(300);
  }
  btn.click(); // on → player fetches track
  for (let i = 0; i < 30 && !store.track(id); i++) await sleep(200);
  if (!wasOn && btn.getAttribute('aria-pressed') === 'true') btn.click(); // restore off
  if (!store.track(id)) {
    captionNotice = store.lastCaptureEmpty
      ? 'YouTube returned an empty caption track; using live captions (CC must stay on)'
      : 'Could not capture caption track; using live captions if CC is on';
  }
}

// ---------- video binding ----------
function onRateChange(): void {
  if (!video || lastApplied === null || adShowing()) return;
  if (Math.abs(video.playbackRate - lastApplied) < 0.01) return;
  if (performance.now() - videoChangedAt < SETTLE_MS) return;
  if (performance.now() - lastUserSpeedInput < USER_INPUT_GRACE_MS) {
    manualOverride = true; // the user picked a speed; respect it until they resume
    lastApplied = video.playbackRate;
  } else if (settings.enabled && controlling && !manualOverride) {
    video.playbackRate = lastApplied; // YouTube reset it (ad end, quality switch…) → re-apply
  }
}

function bindVideo(v: HTMLVideoElement | null): void {
  if (video === v) return;
  video?.removeEventListener('ratechange', onRateChange);
  video = v;
  video?.addEventListener('ratechange', onRateChange);
  const player = document.getElementById('movie_player');
  captionObserver.disconnect();
  if (player) captionObserver.observe(player, { childList: true, subtree: true, characterData: true });
}

function onVideoChange(id: string | null): void {
  if (videoId) store.forget(videoId);
  videoId = id;
  videoChangedAt = performance.now();
  controlling = false;
  manualOverride = false;
  lastApplied = null;
  lastDecisionId = null;
  lastReason = '';
  feedbackAck = null;
  captionNotice = null;
  lastCaptionText = '';
  ctrl = initialState(video?.playbackRate ?? 1);
  ai.clear();
}

// Track user interaction with YouTube's own speed controls.
document.addEventListener(
  'keydown',
  (e) => {
    if (e.shiftKey && (e.key === '>' || e.key === '<' || e.key === '.' || e.key === ',')) lastUserSpeedInput = performance.now();
  },
  true,
);
document.addEventListener(
  'click',
  (e) => {
    if ((e.target as Element | null)?.closest?.('.ytp-settings-menu, .ytp-popup')) lastUserSpeedInput = performance.now();
  },
  true,
);

// ---------- control loop ----------
interface Analysis {
  features: SpeechFeatures | null;
  chunk: string;
  aiKey: string | null;
  /** Chunk position on the timeline, used to order scores for the video average. */
  aiIndex: number;
  aiText: string;
  aiContext: ChunkContext;
  source: string;
}

function videoTitle(): string {
  const h1 = document.querySelector('h1.ytd-watch-metadata')?.textContent?.trim();
  return h1 || document.title.replace(/\s*-\s*YouTube\s*$/, '');
}

function analyze(id: string, t: number): Analysis {
  const title = videoTitle();
  const track = store.track(id);
  if (track) {
    const k = Math.round(t / CHUNK_STEP);
    // Each chunk is scored with the ~20 s before it as context (so recaps can be recognized).
    const chunkFor = (j: number) => {
      const from = j * CHUNK_STEP;
      return {
        text: windowText(track.words, from, from + WINDOW_SEC),
        context: { title, previous: windowText(track.words, from - WINDOW_SEC, from) },
      };
    };
    // Prefetch the next chunks so scores are ready before playback reaches them.
    if (aiReady()) {
      for (const j of [k + 1, k + 2]) {
        const c = chunkFor(j);
        ai.request(`${id}:${j}`, j, c.text, c.context);
      }
    }
    const current = chunkFor(k);
    return {
      features: computeFeatures(track.words, track.cues, t, t + WINDOW_SEC, track.timing),
      chunk: windowText(track.words, t, t + WINDOW_SEC),
      aiKey: `${id}:${k}`,
      aiIndex: k,
      aiText: current.text,
      aiContext: current.context,
      source: `${track.source} (${track.lang}${track.kind ? ', ' + track.kind : ''}, ${track.timing} timing) · lookahead`,
    };
  }
  const live: TimedWord[] = store.liveWords(id);
  if (live.length > 0 && live[live.length - 1]!.t > t - WINDOW_SEC) {
    const from = Math.max(0, t - WINDOW_SEC);
    const text = windowText(live, from, t + 0.01);
    const k = Math.round(t / CHUNK_STEP);
    return {
      features: computeFeatures(live, [], from, t + 0.01, 'live-dom'),
      chunk: text,
      aiKey: `${id}:live:${k}`,
      aiIndex: k,
      aiText: text,
      aiContext: { title, previous: windowText(live, from - WINDOW_SEC, from) },
      source: 'live captions · reactive (no lookahead)',
    };
  }
  return { features: null, chunk: '', aiKey: null, aiIndex: 0, aiText: '', aiContext: {}, source: 'none' };
}

function describeSpeech(f: SpeechFeatures | null): string {
  if (!f) return '—';
  return `${Math.round(f.articulationWpm)} wpm talking (${Math.round(f.wpm)} overall) · ${f.pauseCount} pauses ${Math.round(
    f.pauseRatio * 100,
  )}% · ${f.words} words`;
}

function tick(): void {
  const id = currentVideoId();
  bindVideo(id ? findVideo() : null);
  if (id !== videoId) onVideoChange(id);

  overlay.setVisible(Boolean(settings.showOverlay && id && video));
  if (!id || !video) return;

  const base = {
    enabled: settings.enabled,
    mode: settings.mode,
    profile: settings.profile,
    rate: video.playbackRate,
    aiStatus: aiStatus,
    feedbackAck,
    canResume: false,
    aiAction: null,
  };

  if (!settings.enabled) {
    if (controlling) releaseControl();
    overlay.update({ ...base, speech: '—', ai: '—', transcript: '—', chunk: '', reason: 'AutoSpeed disabled', notice: null });
    return;
  }

  if (video.readyState >= 2 && !video.paused) void ensureCaptionTrack(id);

  const a = analyze(id, video.currentTime);
  const aiResult = aiReady() && a.aiKey ? ai.get(a.aiKey) : null;
  const aiScores = ai.scoresUpTo(a.aiIndex);
  const aiMean = videoMean(aiScores);
  if (aiReady() && a.aiKey && !aiResult) ai.request(a.aiKey, a.aiIndex, a.aiText, a.aiContext);

  let notice: string | null = captionNotice;
  let blocked = false;
  if (!Number.isFinite(video.duration)) {
    notice = 'Live stream: not supported in V1';
    blocked = true;
  } else if (adShowing()) {
    notice = 'Ad playing: paused';
    blocked = true;
  } else if (manualOverride) {
    notice = `Manual speed ${video.playbackRate}× detected: AutoSpeed paused`;
    blocked = true;
  }

  if (!blocked && !video.paused && video.readyState >= 2) {
    const target = computeTarget(
      { features: a.features, complexity: aiResult?.score ?? null, complexityMean: aiMean },
      settings.profile,
      settings.mode,
    );
    lastTargetRate = target.rate;
    const { state, decision } = step(ctrl, target.rate, performance.now());
    ctrl = state;
    if (decision) {
      if (decision.changed) applyRate(decision.rate);
      lastReason = `${target.reason} · ${decision.why}`;
      const entry: DecisionLogEntry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: Date.now(),
        videoId: id,
        videoTime: Number(video.currentTime.toFixed(2)),
        chunk: a.chunk,
        features: a.features,
        aiScore: aiResult?.raw ?? null,
        aiLabel: aiResult?.label ?? null,
        aiMean: aiResult ? Number((aiMean * 10).toFixed(2)) : null,
        previousRate: decision.previousRate,
        selectedRate: decision.rate,
        targetRate: Number(target.rate.toFixed(3)),
        changed: decision.changed,
        mode: settings.mode,
        profile: settings.profile,
        reason: lastReason,
        transcriptSource: a.source,
        feedback: null,
        feedbackAt: null,
      };
      lastDecisionId = entry.id;
      void appendDecision(entry);
    }
  }

  let aiText = 'off (Baseline mode)';
  let aiAction: string | null = null;
  if (settings.mode === 'ai' && !aiReady()) {
    if (aiStatus === 'downloadable' || aiStatus === 'downloading') {
      aiText = downloadProgress ?? (aiStatus === 'downloading' ? 'model downloading… (using speech features only)' : 'model not downloaded yet (using speech features only)');
      aiAction = aiStatus === 'downloadable' && !downloadProgress ? 'Download Gemini Nano' : null;
    } else if (aiStatus === 'unavailable' || aiStatus === 'unsupported') {
      aiText = `Gemini Nano ${aiStatus} on this device/Chrome (using speech features only)`;
    } else {
      aiText = `Gemini Nano status: ${aiStatus} (using speech features only)`;
    }
  } else if (settings.mode === 'ai') {
    if (aiResult) {
      const diff = aiResult.raw - aiMean * 10;
      const vs = Math.abs(diff) < 0.5 ? 'about average' : diff > 0 ? 'harder than avg' : 'easier than avg';
      aiText = `${aiResult.raw}/10, ${vs} ${(aiMean * 10).toFixed(1)} (${aiScores.length} chunks): ${aiResult.label} (${aiResult.latencyMs} ms)`;
    }
    else if (ai.lastError) aiText = `error: ${ai.lastError}`;
    else aiText = a.aiKey ? `pending… (${ai.pending} in flight)` : '— (no transcript)';
  }

  overlay.update({
    ...base,
    rate: video.playbackRate,
    speech: describeSpeech(a.features),
    ai: aiText,
    transcript: a.source,
    chunk: a.chunk.slice(0, 240),
    reason: lastReason ? `${lastReason} (target ${lastTargetRate.toFixed(2)}×)` : 'waiting for first decision…',
    notice,
    canResume: manualOverride,
    aiAction,
  });
}

// ---------- boot ----------
async function boot(): Promise<void> {
  settings = await loadSettings();
  ai.setProvider(providerFor(settings));
  void refreshAiStatus();
  onSettingsChanged((s) => {
    const modeChanged = s.mode !== settings.mode;
    settings = s;
    if (modeChanged) {
      ai.setProvider(providerFor(s));
      void refreshAiStatus();
    }
    tick();
  });
  setInterval(tick, TICK_MS);
  // Poll faster while the model isn't ready, so AI mode kicks in soon after a download finishes.
  setInterval(() => {
    if (aiStatus !== 'available' || Math.random() < 0.2) void refreshAiStatus();
  }, 5000);
}

void boot();
