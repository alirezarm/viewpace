# ViewPace: Chrome Web Store listing

Submission-ready copy. Fields marked **(manifest)** are taken by the Web Store from
`static/manifest.json`, not typed into the dashboard.

---

## Store title (manifest `name`)

```
ViewPace — Smart YouTube Speed
```

> Set in the manifest (`name`), with `short_name: "ViewPace"` for places where space is tight.

## Short description (manifest `description`, max 132 characters)

```
Automatically speeds up easy parts and slows down when content needs more attention.
```

(85 characters, already in the manifest.)

---

## Full description

```
Watch YouTube at the right speed without touching the speed menu.

ViewPace follows the video as it plays: it speeds up when the talking is slow or easy to follow, and slows down when things get dense. You stay in the flow and save time on every video.

HOW IT WORKS
ViewPace reads the video's captions to measure how fast people are talking and where they pause, then adjusts the playback speed a little at a time. Changes are gentle and spaced out, so the speed never jumps around.

PICK YOUR PACE
• Relaxed: stays close to normal speed, up to 1.5×
• Normal: a good start for most videos, up to 2×
• Fast: for confident listeners, up to 2.5×

SMART PACING
With Smart Pacing on, ViewPace also follows what's being said. It slows down when new ideas come up and speeds through small talk. Smart Pacing uses Chrome's built-in, on-device AI (Gemini Nano), so it runs privately on your computer after a one-time download. It currently works with English videos.

Smart Pacing is optional. Without it, ViewPace adjusts to how fast people talk and works right away, with no setup.

YOU'RE ALWAYS IN CONTROL
• Turn ViewPace on or off from the toolbar, the button on the video, or Alt+Shift+S
• Change the speed yourself and ViewPace steps aside for that video
• Rate the speed (Too slow, Just right, Too fast) right from the video
• Ads and live streams play normally

PRIVATE BY DESIGN
• Everything happens on your computer
• No account, no ads, no analytics or tracking
• Captions and video content are never sent to the developer or anyone else
• Your settings and feedback stay in your browser, and you can clear your feedback anytime

Support: viewpace.support@gmail.com
Privacy policy: https://alirezarm.github.io/viewpace-site/PRIVACY.html

Screenshot credits: Video content from "Lesson 1 - Lecture 1 - Astronomy and Science" and "Lesson 1 - Lecture 2 - Numbers and Light Travel Time" by Robert Wagner (Introduction to Astronomy, OpenStax lecture series), youtube.com/watch?v=D5GDztHsL3U and youtube.com/watch?v=MPjJ8KaqBf0, licensed under CC BY 3.0 (creativecommons.org/licenses/by/3.0/). Screenshots cropped and resized.
```

---

## Main features (for reference or a shorter description)

- Adjusts YouTube's speed automatically as the video plays
- Faster through easy stretches, slower when it gets dense
- Three paces: Relaxed, Normal, Fast
- Smart Pacing: follows what's being said, using Chrome's on-device AI (English videos)
- Steps aside when you set the speed yourself
- On/off from the toolbar, the video, or Alt+Shift+S
- Private: no account, no ads, no tracking; everything stays on your computer

## Smart Pacing explanation (short form)

Smart Pacing lets ViewPace follow what's being said, not just how fast it's said: it slows down
when new ideas come up and speeds through small talk. It runs on Chrome's built-in, on-device AI
(Gemini Nano), so nothing leaves your computer. It needs a one-time download, depends on your Chrome
version and device, and currently works with English videos. Without it, ViewPace still adjusts to
how fast people talk.

## Privacy / on-device (short form)

ViewPace works entirely on your computer. It reads the video's captions to set the speed, and that
text is processed locally and never sent anywhere. There's no backend, no account, no advertising,
and no analytics or telemetry. Your settings and feedback are stored in your browser; feedback can be
cleared anytime from ViewPace's Advanced settings.

## Compatibility

- Google Chrome on desktop (Windows, macOS, Linux, ChromeOS), version 138 or later
- Works on YouTube videos at youtube.com that have captions (uploaded or auto-generated). Videos
  without captions keep their normal speed.
- To read the captions, ViewPace may briefly turn captions on and back off when a video starts
  (can be switched off in Advanced settings)
- Not used on Shorts, live streams or ads
- Smart Pacing: needs Chrome's on-device AI, which depends on your Chrome version and device;
  English videos only for now

## Support

Questions or problems? Contact viewpace.support@gmail.com. Please include the video link and which pace
you were using.

---

## Dashboard fields (privacy practices tab)

**Single purpose**

```
ViewPace automatically adjusts YouTube playback speed based on how fast people are speaking and, optionally, how dense the spoken content is.
```

**Permission justification: storage**

```
Saves the user's settings (on/off, pace, Smart Pacing) and their optional speed feedback locally in the browser.
```

**Permission justification: host access (www.youtube.com)**

```
Reads the captions and playback state of the YouTube video being watched and sets its playback speed. ViewPace runs only on YouTube.
```

**Remote code:** No. All code is included in the package.

**Data usage:** ViewPace does not collect or transmit user data. Captions are processed on the
device; settings and feedback are stored locally only.
