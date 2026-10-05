# AutoSpeed (prototype)

Manifest V3 Chrome extension that varies YouTube playback speed according to how carefully the
upcoming content needs to be heard. Local only: no backend, no cloud LLM, no analytics.

## Load it

```bash
npm install
npm run check        # typecheck + unit tests + build → dist/
npm run watch        # rebuild TS on change (re-copy static/ by restarting)
```

`chrome://extensions` → Developer mode → **Load unpacked** → select `dist/`.
After each rebuild: press reload on the extension card, then reload the YouTube tab.

Toggle instantly with **Alt+Shift+S**, the badge menu on the video, or the popup.

## First run and smart pacing setup

- On install, AutoSpeed opens a welcome page. It already works in speech-only (Baseline) mode, with
  no setup needed.
- "Smart pacing" is the user-facing name for AI mode. Its states are: on, needs a one-time download
  (one button: *Turn on smart pacing*), downloading, unavailable. The logic is in
  `src/shared/onboarding.ts`; the card UI in `src/shared/smart-card.ts` is shared by the popup and
  the welcome page.
- When the model becomes available (setup button, a background download finishing, or already
  present), AI mode is switched on automatically, unless the user picked an analysis mode
  themselves in Advanced (`modeChosenByUser`). The check runs on install, at browser startup, and on
  every availability check from a YouTube tab.
- If unavailable, AutoSpeed says so once on the welcome page and is silent everywhere else. Raw
  status and the last setup error are shown under Advanced.
- State is stored in `chrome.storage.local` under `autospeed.onboarding`.

## Robustness rules

AutoSpeed should never make YouTube worse:

- **Never fight** (`src/content/rate-owner.ts`): a speed change AutoSpeed didn't make pauses
  adaptation for that video (Resume from the badge). Exceptions: AutoSpeed re-applies its own speed
  only during known YouTube resets (3 s after a media load); changes during ads or while AutoSpeed
  is off are ignored; a change that returns to AutoSpeed's speed within 15 s (e.g. press-and-hold
  2×) resumes automatically.
- **No data, no change** (`src/content/guards.ts`): without a transcript, or before live captions
  cover a full 20 s window, AutoSpeed leaves the speed alone. Pauses and music *inside* a caption
  track are still handled by the speed algorithm.
- **Give the speed back**: leaving a video (another video, home, miniplayer, Shorts), an ad
  starting, a live stream, or turning AutoSpeed off restores the user's own speed, captured once
  before AutoSpeed's first change.
- **Orphaned tabs**: after an extension update/reload, old content scripts detect it, restore the
  user's speed, remove their UI and stop.
- **Captions**: loading is only attempted when no ad is on screen and the player has switched to
  the URL's video (checked via the player API in the MAIN-world hook), with one retry. CC is
  switched back off as soon as the player has its answer (at most 2.5 s). Original-language tracks
  are preferred over auto-translated ones.
- **Current video only**: transcripts, live captions, caption-response counts, caption attempts,
  AI scores and the page hook's replay buffer are kept in memory for the current video only and
  dropped on every video change (anything already captured for the new video is kept).
- **AI**: one request in flight; chunks behind the playhead are skipped; lost messages (worker
  restarts) don't count as model failures.
- **Logging**: by default only feedback clicks are stored (numbers, no transcript text; max 500).
  The full decision log with transcript text is an Advanced opt-in (max 1000).

## User interface

- **Popup:** on/off switch, pace (Relaxed / Normal / Fast) with the pace's speed range and the live
  speed of the current video, and a "Smart pacing" status (the AI enhancement, shown in AI mode),
  including one-click setup when the model still needs downloading.
- **Advanced** (collapsed in the popup): analysis mode (Speech only = Baseline, Speech + content =
  AI), speed badge on/off, detailed debug overlay, automatic caption reading, model status, and the
  feedback log (export/clear).
- **Speed badge** (default): a small badge in the player's bottom-right corner. It follows YouTube's
  control visibility and appears for 4 s after each speed change with a plain-language reason. Click
  it to rate the speed (Too slow / Just right / Too fast) or turn AutoSpeed off.
- **Debug overlay** (Advanced): the detailed research panel with speech rate, AI scores, transcript
  chunk and decision reasons. It replaces the badge while enabled.

## Feasibility findings (checked 2026-10-04, Chrome 154)

| Spec item | Verdict | What V1 does |
|---|---|---|
| Fetch timed captions from the extension | **Does not work.** The caption `baseUrl` (`exp=xpe`) returns an empty `200`. YouTube requires a proof-of-origin token (`pot`) minted by the player's BotGuard. Re-fetching the player's own URL, `pot` included, also returned empty: the token looks single-use. | A MAIN-world script at `document_start` wraps XHR/fetch and **copies the response body of the player's own `/api/timedtext` request**. The player only makes that request when CC turns on, so AutoSpeed briefly toggles CC (then restores it) once per video. It also captures `get_transcript` if the user opens "Show transcript". |
| Captions always available | No. Some videos have none, and YouTube can still return an empty track. | Fallback: read the live on-screen caption DOM. This is **reactive only** (past 20 s, no lookahead) and needs CC left on. The overlay shows which source is active. |
| Pause detection from transcript | Approximate. Auto-generated (ASR) tracks have per-word onsets, so gaps ≈ silences. Uploaded captions have only cue timing, so only gaps between cues register. | Both are supported; `timing: word/cue` is logged with every decision. Audio-based VAD is out of scope for V1. |
| Gemini Nano via Prompt API | Works in extensions on Chrome 138+ (no manifest permission; remove the old `aiLanguageModelOriginTrial`). Hardware gate: ≥22 GB free disk, GPU >4 GB VRAM or 16 GB RAM + 4 cores; macOS 13+/Win 10+/Linux. Not exposed to web-page workers, but Chrome enables it for **extension service workers** (`chrome_content_renderer_client.cc` → `EnableAIPromptAPIForWorkers` in extension processes; Google's own samples call it from `background.js`). The first download needs a user gesture. Languages: en/es/ja (+ de/fr in newer builds). | Runs in the **service worker**; the session is re-created lazily after Chrome stops the worker (~30 s idle). The model download is triggered from the popup button (user gesture). Constrained JSON output `{complexity: 0–10, reason}` is clamped and validated. Scores are fetched ahead per 20 s chunk and cached, so the control loop never waits on inference. |
| "Every 7 s", no oscillation | Feasible. | Decisions every ≥7 s wall-clock, 0.1× hysteresis (0.2× to reverse within 21 s), max −0.5× / +0.25× per change (slow down fast, speed up gradually), 0.05× quantization. No extra smoothing: the 20 s window already smooths. |
| User changes speed | YouTube also resets `playbackRate` itself (ads, quality changes, new video). | A rate change within 1.5 s of the user touching YouTube's speed menu or Shift+</> counts as **manual override**: AutoSpeed pauses and shows a Resume button. Other unexpected resets are re-applied. |
| Ads, live streams, Shorts | Not meaningful targets. | Paused during ads (`.ad-showing`); live streams and Shorts are skipped. |
| Other speed extensions | They will fight over `playbackRate`. | Disable them while testing. |
| Non-English | Word counting assumes space-separated words; Nano is configured for `en`. | Works best on English. CJK speech-rate numbers will be wrong. |

Not verifiable here: Chrome's automation mode (`navigator.webdriver`) makes YouTube serve empty
captions even to its own player. The capture hook was confirmed to intercept the player's requests,
but caption *content* has to be confirmed in your normal Chrome profile.

## Architecture

```
youtube.com tab
 ├─ hook.js (MAIN world, document_start)  wraps XHR/fetch → postMessage(timedtext body)
 └─ content.js (isolated world)
     ├─ captions.ts    json3 / srv3 / legacy XML / transcript-panel → words + cues
     ├─ transcript.ts  per-video track store + live caption-DOM fallback
     ├─ features.ts    wpm, articulation wpm, pauses over [t, t+20 s)
     ├─ ai.ts          ComplexityProvider interface (NanoProvider | DisabledProvider) + lookahead cache
     ├─ controller.ts  signals → target rate → smoothed, rate-limited decision (pure, unit-tested)
     ├─ overlay.ts     shadow-DOM debug panel + Too Slow / Good / Too Fast
     └─ main.ts        1 s tick loop, video/ad/override handling, logging
background.js (service worker)  Gemini Nano session (system prompt + responseConstraint), ai:* messages, Alt+Shift+S command
popup.js                       mode, profile, Nano status/download, export/clear log
chrome.storage.local           autospeed.settings, autospeed.log (≤5000 decisions)
```

### Rate mapping

`rate = comfortWpm / talkingWpm × (1 + pauseBonus)`, clamped to the profile range. `talkingWpm`
is the articulation rate over the upcoming 20 s window (pauses excluded), so a fast speaker who pauses
a lot isn't mistaken for a slow one. `pauseBonus = min(0.25, 0.5 × pauseRatio)` speeds up pause-heavy
speech separately.

| Profile | comfort wpm | range | default (little/no speech) |
|---|---|---|---|
| Relaxed | 200 | 1.0–1.5× | 1.15× |
| Normal | 250 | 1.0–2.0× | 1.35× |
| Fast | 320 | 1.1–2.5× | 1.6× |

**AI Adaptive** judges each chunk's complexity `c ∈ [0,1]` *relative to this video's reference*
`m`: `comfortWpm × clamp(1 − 0.4·(c − m), 0.8, 1.2)`. `m` is computed from chunks already scored for
playback, in timeline order (no extra model calls): a plain average blended with a prior of 0.5
worth 3 chunks for the first ~7 chunks, then a moving average (`m ← 0.9·m + 0.1·c`) so it follows a
video that gets harder or easier. Each chunk is scored with the video title and the preceding 20 s
of transcript as context (marked "do not score"), so recaps can be recognized. A uniformly dense video therefore plays at about Baseline speed
on average; AI mode only redistributes time toward the harder parts. The model only produces `c`;
it never picks a speed. If no score is ready, the decision falls back to speech features and the reason says so.

## Log format

Popup → **Export JSON**. One entry per decision (every ≥7 s, including "hold" decisions):
`timestamp, videoId, videoTime, chunk, features{wpm, articulationWpm, pauseCount, pauseSec,
pauseRatio, words, timing}, aiScore, aiLabel, aiMean, previousRate, selectedRate, targetRate, changed,
mode, profile, reason, transcriptSource, feedback, feedbackAt`. Feedback buttons attach to the
most recent decision.

## Tuning knobs

`src/content/controller.ts` → `PROFILES`, `CONTROL` (interval, hysteresis, max step, EMA, AI weight).
`src/shared/complexity-prompt.ts` → scoring rubric and output schema.
