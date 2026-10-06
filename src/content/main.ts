import { MAX_DECISION_ENTRIES, MAX_FEEDBACK_ENTRIES, appendDecision, attachFeedback, feedbackOnlyEntry } from '../shared/log';
import { PAGE_TAG, type ContentToPage, type PageToContent } from '../shared/messages';
import { loadSettings, onSettingsChanged, saveSettings, type Settings } from '../shared/settings';
import type { AiAvailability, DecisionLogEntry, Feedback, SpeechFeatures, TimedWord } from '../shared/types';
import { chooseMode, setUpSmartPacing } from '../shared/onboarding';
import { ComplexityCache, DisabledProvider, NanoProvider, type ComplexityProvider } from './ai';
import type { ChunkContext } from '../shared/complexity-prompt';
import { PROFILES, computeTarget, initialState, step, videoMean, type ControllerState } from './controller';
import { computeFeatures, windowText } from './features';
import { Overlay } from './overlay';
import { Badge, type BadgeView } from './badge';
import { describeChange } from './friendly';
import type { TabRequest, TabStatus } from '../shared/messages';
import { TranscriptStore } from './transcript';
import { RateOwner } from './rate-owner';
import { toggleCaptionsForTrack } from './caption-toggle';
import { UsageMeter, addStats, analysisOf, type Analysis as ScoringKind } from '../shared/stats';
import { CaptionAttempts, captionAttemptAllowed, captionPlan, hasEnoughData, transcriptPanelTarget, isExtensionAlive, type TranscriptKind } from './guards';

const TICK_MS = 1000;
const WINDOW_SEC = 20; // analysis window length (media seconds)
const CHUNK_STEP = 10; // AI chunk grid step (media seconds)
const AD_SETTLE_MS = 3000; // YouTube may still adjust the speed this long after an ad ends
const CAPTION_WAIT_MS = 2500; // longest CC stays switched on while loading the caption track
const PLAYER_INFO_FRESH_MS = 3000;

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
/** Who owns the playback speed; ViewPace never fights changes it didn't make. */
const owner = new RateOwner();
let lastAdSeenAt = -Infinity;
let wasAd = false;
let lastReason = '';
let lastTargetRate = 1;
let lastDecisionId: string | null = null;
let lastDecision: DecisionLogEntry | null = null;
let feedbackAck: string | null = null;
const captionAttempts = new CaptionAttempts();
/** Only one caption load at a time, across videos: they all toggle the same player CC button. */
let captionLoadBusy = false;
/** What YouTube's player API says it has loaded (from the MAIN-world hook). */
let playerInfo = { videoId: null as string | null, isLive: false, at: -Infinity };
let tickTimer: ReturnType<typeof setInterval> | undefined;
let statusTimer: ReturnType<typeof setInterval> | undefined;
let shutDown = false;
// Local beta usage counters (fixed size; see shared/stats.ts).
const meter = new UsageMeter();
let adaptedThisVideo = false;
let suspendAnalysis: ScoringKind = 'speech';
let ticksSinceFlush = 0;
const FLUSH_EVERY_TICKS = 30;
let captionNotice: string | null = null;
// User-facing badge state
let flashText: string | null = null;
let flashUntil = 0;
let badgeAck: string | null = null;
let tabStatus: TabStatus = { onVideo: false, state: 'idle', rate: null };
const FLASH_MS = 4000;

const overlay = new Overlay({
  onFeedback: (f) => void giveFeedback(f),
  onToggleEnabled: () => void saveSettings({ enabled: !settings.enabled }),
  onToggleMode: () => void chooseMode(settings.mode === 'ai' ? 'baseline' : 'ai'),
  onDownloadModel: () => void downloadModel(),
  onResume: () => resumeAfterOverride(),
});

const badge = new Badge({
  onFeedback: (f) => void giveFeedback(f),
  onToggleEnabled: () => void saveSettings({ enabled: !settings.enabled }),
  onResume: () => resumeAfterOverride(),
});

function resumeAfterOverride(): void {
  owner.resume();
  ctrl = initialState(video?.playbackRate ?? 1);
}

/** Plain-language version of the caption status, for the badge. Null = nothing worth saying. */
function captionHint(notice: string | null): string | null {
  if (!notice || notice.startsWith('Loading')) return null;
  if (notice.startsWith('This video has no captions')) return 'No captions, so the pace stays steady';
  if (notice.startsWith('Turn on CC')) return 'Turn on captions (CC) so ViewPace can follow along';
  return 'Couldn\'t read the captions. Keep CC on to help';
}

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
 * is shared browser-wide, so downloading it here also makes it available to the service worker.
 */
async function downloadModel(): Promise<void> {
  downloadProgress = 'starting download…';
  try {
    await setUpSmartPacing((f) => (downloadProgress = `downloading ${Math.round(f * 100)}%`));
    downloadProgress = null;
  } catch (e) {
    downloadProgress = `download failed (${e instanceof Error ? e.message : String(e)}): try the ViewPace popup`;
  }
  void refreshAiStatus();
}

function applyRate(rate: number, analysis: ScoringKind): void {
  if (!video) return;
  if (!owner.controlling && !adaptedThisVideo) {
    adaptedThisVideo = true;
    meter.videoAdapted(analysis);
  }
  owner.take(rate, video.playbackRate);
  video.playbackRate = rate;
}

/** Give the speed back to the user (their own speed), if ViewPace was in control. */
function releaseControl(): void {
  const restore = owner.release();
  if (video && restore !== null) video.playbackRate = restore;
  ctrl = initialState(video?.playbackRate ?? 1);
}

/** Write the usage counters gathered since the last flush. */
function flushStats(): void {
  ticksSinceFlush = 0;
  const delta = meter.takeDelta();
  if (delta && isExtensionAlive()) void addStats(delta).catch(() => undefined);
}

/**
 * This content script has been orphaned by an extension update/reload. It can no longer
 * receive settings (so it can't be turned off): hand the speed back and stop completely.
 */
function shutdown(): void {
  if (shutDown) return;
  shutDown = true;
  clearInterval(tickTimer);
  clearInterval(statusTimer);
  releaseControl();
  bindVideo(null);
  captionObserver.disconnect();
  overlay.remove();
  badge.remove();
}

async function giveFeedback(f: Feedback): Promise<void> {
  const decision = lastDecision;
  const loggedId = lastDecisionId;
  if (!decision) {
    feedbackAck = 'No decision logged yet';
    badgeAck = 'Let the video play a few seconds, then try again';
    return;
  }
  // With the full decision log on, annotate the logged decision; otherwise keep a small
  // feedback-only record (numbers, no transcript text).
  let ok = false;
  try {
    ok = loggedId !== null && (await attachFeedback(loggedId, f));
    if (!ok) {
      await appendDecision(feedbackOnlyEntry(decision, f, Date.now()), MAX_FEEDBACK_ENTRIES);
      ok = true;
    }
  } catch {
    ok = false;
  }
  const label = { too_slow: 'Too Slow', good: 'Good', too_fast: 'Too Fast' }[f];
  feedbackAck = ok ? `Logged "${label}" @ ${decision.id.slice(-6)}` : 'Could not log feedback';
  badgeAck = ok ? 'Feedback saved' : 'Couldn\'t save feedback';
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
    // Assign it to the video it was requested for; drop it if the user has moved on since.
    const id = transcriptPanelTarget(msg.videoId, currentVideoId());
    if (id) store.ingestTranscriptPanel(id, msg.body);
  } else if (msg.type === 'player-info') {
    playerInfo = { videoId: msg.videoId, isLive: msg.isLive, at: performance.now() };
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
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The player's own video id, if the hook reported it recently. */
function freshPlayerVideoId(): string | null {
  return performance.now() - playerInfo.at < PLAYER_INFO_FRESH_MS ? playerInfo.videoId : null;
}

/**
 * The only reliable way to get the timed track is to let the player request it. If CC is off,
 * briefly turn it on (the player fetches the whole track), then restore the user's choice as soon
 * as the player has its answer. Only tried when it can mean something: no ad, the player has
 * switched to this video, and at most one retry.
 */
async function ensureCaptionTrack(id: string): Promise<void> {
  if (store.track(id)) return;
  const attempt = captionAttempts.get(id);
  const now = performance.now();
  if (
    captionLoadBusy ||
    attempt.running ||
    !captionAttemptAllowed({
      inAd: adShowing(),
      msSinceVideoChange: now - videoChangedAt,
      playerVideoId: freshPlayerVideoId(),
      urlVideoId: id,
      attempts: attempt.count,
      msSinceLastAttempt: now - attempt.last,
    })
  ) {
    return;
  }
  const btn = document.querySelector<HTMLButtonElement>('#movie_player .ytp-subtitles-button');
  const plan = captionPlan({
    available: Boolean(btn && btn.offsetParent !== null && btn.getAttribute('aria-disabled') !== 'true'),
    ccOn: btn?.getAttribute('aria-pressed') === 'true',
    autoEnableCaptions: settings.autoEnableCaptions,
  });
  if (plan === 'needs-cc') {
    // Nothing is tried, so no attempt is used up: turning the setting on later still loads them.
    captionNotice = 'Turn on CC once to load the transcript';
    return;
  }
  captionAttempts.start(id, now);
  captionLoadBusy = true;
  try {
    if (plan === 'no-captions') captionNotice = 'This video has no captions';
    else await loadCaptionTrack(id);
  } finally {
    captionLoadBusy = false;
    captionAttempts.finish(id);
  }
}

async function loadCaptionTrack(id: string): Promise<void> {
  captionNotice = 'Loading caption track…';
  const before = store.responseCount(id);
  // Identity is checked live after every wait: the URL (not the per-second cached id) and the
  // player element itself (YouTube may replace it).
  const player = document.getElementById('movie_player');
  const result = await toggleCaptionsForTrack({
    button: () => {
      const b = player?.querySelector<HTMLButtonElement>('.ytp-subtitles-button');
      return b
        ? { isOn: () => b.getAttribute('aria-pressed') === 'true', click: () => b.click(), isConnected: () => b.isConnected }
        : null;
    },
    sleep,
    isCurrent: () => currentVideoId() === id && document.getElementById('movie_player') === player,
    responded: () => store.responseCount(id) !== before,
    waitMs: CAPTION_WAIT_MS,
  });
  // After a navigation the next video has its own caption state: don't touch it.
  if (result !== 'done') return;
  if (!store.track(id)) {
    captionNotice = store.lastCaptureEmpty
      ? 'YouTube returned an empty caption track; using live captions (CC must stay on)'
      : 'Could not capture caption track; using live captions if CC is on';
  }
}

// ---------- video binding ----------
function inAdOrJustAfter(): boolean {
  return adShowing() || performance.now() - lastAdSeenAt < AD_SETTLE_MS;
}

/** Never fight a speed change ViewPace didn't make. */
function onRateChange(): void {
  if (!video) return;
  // While ViewPace is off, the user's speed changes are simply theirs: nothing to pause.
  const wasControlling = owner.controlling;
  const action = owner.onRateChange(video.playbackRate, performance.now(), inAdOrJustAfter() || !settings.enabled);
  if (action === 'reapply' && owner.applied !== null) video.playbackRate = owner.applied;
  else if (action === 'resume') {
    ctrl = initialState(video.playbackRate);
    meter.temporaryOverride(suspendAnalysis);
  } else if (action === 'suspend' && wasControlling) {
    // Only a change while ViewPace was choosing the speed counts as overriding it.
    suspendAnalysis = lastDecision ? analysisOf(lastDecision) : 'speech';
    meter.override(suspendAnalysis);
  }
}

/** The player is (re)loading media: YouTube may apply its own speed for a moment. */
function onLoadStart(): void {
  owner.settle(performance.now());
}

function bindVideo(v: HTMLVideoElement | null): void {
  if (video === v) return;
  releaseControl(); // Hand the old element its user speed back before letting go of it
  video?.removeEventListener('ratechange', onRateChange);
  video?.removeEventListener('loadstart', onLoadStart);
  video = v;
  video?.addEventListener('ratechange', onRateChange);
  video?.addEventListener('loadstart', onLoadStart);
  const player = document.getElementById('movie_player');
  captionObserver.disconnect();
  if (player && v) captionObserver.observe(player, { childList: true, subtree: true, characterData: true });
}

function onVideoChange(id: string | null): void {
  // Leaving a video (another video, the home page, the miniplayer, Shorts) gives the
  // user's own speed back; the next video starts from it until ViewPace is confident.
  releaseControl();
  flushStats();
  adaptedThisVideo = false;
  // Transient data is kept for the current video only (keeping anything already captured for it).
  store.retainOnly(id);
  captionAttempts.retainOnly(id);
  videoId = id;
  videoChangedAt = performance.now();
  owner.newVideo(videoChangedAt);
  lastDecisionId = null;
  lastDecision = null;
  lastReason = '';
  feedbackAck = null;
  badgeAck = null;
  flashText = null;
  captionNotice = null;
  lastCaptionText = '';
  ctrl = initialState(video?.playbackRate ?? 1);
  ai.clear();
}

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
  kind: TranscriptKind;
  /** Seconds of continuous live captions behind the playhead (live kind only). */
  liveCoverage: number;
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
      source: `${track.source} (${track.lang}${track.kind ? ', ' + track.kind : ''}${track.translated ? ', translated' : ''}, ${track.timing} timing) · lookahead`,
      kind: 'track',
      liveCoverage: 0,
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
      kind: 'live',
      liveCoverage: store.liveCoverage(id, t),
    };
  }
  return { features: null, chunk: '', aiKey: null, aiIndex: 0, aiText: '', aiContext: {}, source: 'none', kind: 'none', liveCoverage: 0 };
}

function describeSpeech(f: SpeechFeatures | null): string {
  if (!f) return '—';
  return `${Math.round(f.articulationWpm)} wpm talking (${Math.round(f.wpm)} overall) · ${f.pauseCount} pauses ${Math.round(
    f.pauseRatio * 100,
  )}% · ${f.words} words`;
}

function tick(): void {
  if (shutDown) return;
  if (!isExtensionAlive()) return shutdown();
  window.postMessage({ [PAGE_TAG]: true, type: 'player-info?' } satisfies ContentToPage, location.origin);
  const id = currentVideoId();
  bindVideo(id ? findVideo() : null);
  if (id !== videoId) onVideoChange(id);

  const onVideo = Boolean(id && video);
  const playable = onVideo && Number.isFinite(video!.duration) && !adShowing();
  overlay.setVisible(Boolean(settings.debugOverlay && onVideo));
  badge.setVisible(Boolean(settings.showOverlay && !settings.debugOverlay && playable));
  if (!id || !video) {
    meter.tick(performance.now(), false, 1, 'speech');
    tabStatus = { onVideo: false, state: 'idle', rate: null };
    return;
  }
  if (++ticksSinceFlush >= FLUSH_EVERY_TICKS) flushStats();
  const range = PROFILES[settings.profile];
  const badgeBase: Omit<BadgeView, 'state' | 'line' | 'flash'> = {
    rate: video.playbackRate,
    minRate: range.minRate,
    maxRate: range.maxRate,
    ack: badgeAck,
  };

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

  // Ads: hand the speed back while an ad plays (never speed up ads); adapt again afterwards.
  const ad = adShowing();
  if (ad) {
    if (!wasAd) releaseControl();
    lastAdSeenAt = performance.now();
  }
  wasAd = ad;

  if (!settings.enabled) {
    releaseControl();
    overlay.update({ ...base, speech: '—', ai: '—', transcript: '—', chunk: '', reason: 'ViewPace disabled', notice: null });
    badge.update({ ...badgeBase, state: 'off', line: null, flash: false });
    tabStatus = { onVideo: true, state: 'off', rate: video.playbackRate };
    meter.tick(performance.now(), false, 1, 'speech');
    return;
  }

  const live = !Number.isFinite(video.duration) || (playerInfo.isLive && freshPlayerVideoId() === id);
  if (!live && video.readyState >= 2 && !video.paused) void ensureCaptionTrack(id);

  const a = analyze(id, video.currentTime);
  const aiResult = aiReady() && a.aiKey ? ai.get(a.aiKey) : null;
  const aiScores = ai.scoresUpTo(a.aiIndex);
  const aiMean = videoMean(aiScores);
  ai.setPlayhead(a.aiIndex);
  if (aiReady() && a.aiKey && !aiResult) ai.request(a.aiKey, a.aiIndex, a.aiText, a.aiContext);

  let notice: string | null = captionNotice;
  let blocked = false;
  if (live) {
    releaseControl(); // in case the live signal arrived after ViewPace had already acted
    notice = 'Live stream: not supported';
    blocked = true;
  } else if (ad) {
    notice = 'Ad playing: paused';
    blocked = true;
  } else if (owner.suspended) {
    notice = `Manual speed ${video.playbackRate}× detected: ViewPace paused`;
    blocked = true;
  } else if (!hasEnoughData(a.kind, a.liveCoverage, WINDOW_SEC)) {
    // No transcript or not enough of it: leave the user's speed alone.
    if (!notice) notice = a.kind === 'live' ? 'Collecting live captions…' : 'Waiting for captions: speed unchanged';
    blocked = true;
  }
  // While ViewPace isn't in control, its controller starts from whatever speed is playing.
  if (!owner.controlling) ctrl = { ...ctrl, current: video.playbackRate };

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
      if (decision.changed) {
        applyRate(decision.rate, aiResult ? 'content' : 'speech');
        flashText = describeChange({
          previousRate: decision.previousRate,
          rate: decision.rate,
          mode: settings.mode,
          aiScore: aiResult?.raw ?? null,
          aiMean: aiResult ? aiMean * 10 : null,
          pauseRatio: a.features?.pauseRatio ?? null,
          littleSpeech: !a.features || a.features.words < 8,
        });
        flashUntil = performance.now() + FLASH_MS;
      }
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
      lastDecision = entry;
      // The full decision log (with transcript text) is a developer opt-in.
      lastDecisionId = settings.keepDecisionLog ? entry.id : null;
      if (settings.keepDecisionLog) void appendDecision(entry, MAX_DECISION_ENTRIES).catch(() => undefined);
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
    canResume: owner.suspended,
    aiAction,
  });

  // Time-weighted speed: count playback only while ViewPace is choosing the speed.
  const counting = owner.controlling && !video.paused && !ad && !live;
  meter.tick(performance.now(), counting, video.playbackRate, aiResult ? 'content' : 'speech');

  const flashing = performance.now() < flashUntil;
  badge.update({
    ...badgeBase,
    rate: video.playbackRate,
    state: owner.suspended ? 'paused-by-user' : 'active',
    line: flashing ? flashText : a.source === 'none' || a.source.startsWith('live') ? captionHint(captionNotice) : null,
    flash: flashing,
  });
  tabStatus = {
    onVideo: true,
    state: live ? 'unsupported' : ad ? 'ad' : owner.suspended ? 'paused-by-user' : 'active',
    rate: video.playbackRate,
  };
}

// The popup asks the active tab for its live status.
chrome.runtime.onMessage.addListener((msg: TabRequest, _sender, sendResponse: (s: TabStatus) => void) => {
  if (msg?.kind !== 'tab:status') return false;
  sendResponse(tabStatus);
  return false;
});

// ---------- boot ----------
async function boot(): Promise<void> {
  settings = await loadSettings();
  ai.setProvider(providerFor(settings));
  void refreshAiStatus();
  onSettingsChanged((s) => {
    const modeChanged = s.mode !== settings.mode;
    if (s.enabled && !settings.enabled) resumeAfterOverride(); // turning ViewPace on starts fresh
    settings = s;
    if (modeChanged) {
      ai.setProvider(providerFor(s));
      void refreshAiStatus();
    }
    tick();
  });
  tickTimer = setInterval(tick, TICK_MS);
  // Don't lose the last few seconds of counters when the tab goes away.
  addEventListener('pagehide', flushStats);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushStats();
  });
  // Poll faster while the model isn't ready, so AI mode kicks in soon after a download finishes.
  // Once it's ready, check rarely, and not at all while nothing plays (lets the worker sleep).
  statusTimer = setInterval(() => {
    if (!isExtensionAlive()) return shutdown();
    if (aiStatus !== 'available') void refreshAiStatus();
    else if (video && !video.paused && Math.random() < 0.2) void refreshAiStatus();
  }, 5000);
}

void boot();
