# ViewPace Privacy Policy

> **Draft for review.** Fill in the placeholders marked `[TODO]` before publishing.

**Effective date:** [TODO]
**Contact:** [TODO: contact email]

ViewPace is a Chrome extension that automatically adjusts YouTube playback speed: it speeds up easy
parts and slows down when content needs more attention. This policy explains what data ViewPace
uses, where it is processed and stored, and how you can delete it.

## Summary

- ViewPace works entirely on your computer. It has **no backend server, no account, no advertising,
  no analytics SDK, and no telemetry service**.
- ViewPace **does not send** transcripts, captions, video content, viewing history, or any other
  data to the developer or to any third party.
- Settings, bounded beta statistics, and your feedback are stored **locally in Chrome** and can be
  cleared at any time.

## What ViewPace reads, and why

ViewPace runs only on `https://www.youtube.com/*`. On YouTube watch pages it reads:

- **Captions and transcripts.** When YouTube's player loads a caption track (or you open "Show
  transcript"), ViewPace reads the response the player received. If needed, it briefly turns
  captions on so the player loads them, then restores your setting. It may also read captions shown
  on screen. ViewPace uses this text and its timing to measure how fast people speak and how much
  they pause.
- **Playback state.** The current playback speed and position, whether an ad or a live stream is
  playing, and which video is loaded, so that ViewPace can set the speed and never override a speed
  you chose.
- **The video title,** used as context for Smart Pacing (below).

Transcripts are kept **in memory only, for the video you are watching**, and are discarded when you
move to another video or close the tab.

## Smart Pacing (on-device AI)

Smart Pacing is optional. Speech-based pacing works without it. When it is enabled and available,
ViewPace sends short transcript excerpts (about 20 seconds of speech, with the preceding excerpt
and the video title as context) to **Gemini Nano, the AI model built into Chrome, which runs on your
device**. The model returns a difficulty score that ViewPace uses to adjust the speed. This
processing happens locally in Chrome; ViewPace does not send these excerpts anywhere.

Smart Pacing requires a one-time download of the model, which **Chrome performs** when you choose
"Turn on smart pacing". That download is handled by Chrome and governed by Google's terms, not by
ViewPace. Availability depends on your Chrome version and device, and content analysis currently
supports English videos.

## What ViewPace stores

All storage is local to your Chrome profile (`chrome.storage.local`, and the extension page's local
storage). Nothing is synced or uploaded by ViewPace.

| Data | Contents | Limit |
|---|---|---|
| Settings | On/off, pace, analysis mode, display options | One small record |
| Setup state | Whether the welcome page was shown, whether you chose the analysis mode yourself, the last setup error | One small record |
| Feedback | For each Too slow / Just right / Too fast click: the time, YouTube video ID, position in the video, the speeds involved, speech measurements (e.g. words per minute, pauses), the Smart Pacing score if one was used, the pace and mode, and which caption track was used (language, auto-generated or uploaded). **No transcript text.** | Most recent 500 entries |
| Beta statistics | Totals per analysis type: seconds watched while ViewPace set the speed, average speed, number of videos adapted, number of manual speed changes | One fixed-size record |
| Detailed decision log *(off by default)* | Only if you turn on **Keep detailed decision log** under Advanced: each speed decision with the **transcript excerpt** it was based on and the AI's short description of it, in addition to the feedback fields above | Most recent 1,000 entries |
| Popup display state | Whether the Advanced section is open | One flag |

**Export.** "Export JSON" under Advanced saves the feedback, decision log (if enabled) and statistics
to a file on your computer. The file stays with you; ViewPace does not send it anywhere.

## Deleting your data

- **Clear data** (popup → Advanced) deletes the feedback, the decision log and the beta statistics.
- Turning off **Keep detailed decision log** stops recording transcript excerpts. Use **Clear data**
  to remove excerpts that were already recorded.
- **Removing the extension** deletes everything ViewPace stored.

## Sharing

ViewPace does not sell, transfer, or share user data with anyone. It does not use or transfer data
for advertising, for purposes unrelated to adjusting playback speed, or to determine
creditworthiness or for lending purposes.

## Chrome Web Store Limited Use

The use of information received by ViewPace complies with the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq),
including the **Limited Use** requirements. ViewPace uses data only to provide its single purpose
(adjusting YouTube playback speed), does not transfer it to third parties, does not use it for
advertising, and does not allow humans to read it. All processing happens on your device.

## Permissions

- **storage:** to save the settings, feedback and statistics described above.
- **Access to `www.youtube.com`:** to read captions and playback state and to set the playback speed
  on YouTube pages. ViewPace does not run on other websites.

## Changes

If this policy changes, the updated version will be published with a new effective date.

ViewPace is not affiliated with or endorsed by YouTube or Google.
