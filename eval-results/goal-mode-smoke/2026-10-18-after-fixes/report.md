# Goal Mode smoke test

Video: https://www.youtube.com/watch?v=zjkBMFhNj_g  
Goal A: Understand how LLMs are trained and turned into assistants.  
Goal B: Understand the security risks of LLMs, especially jailbreaks and prompt injection.

## Checks

| | Check | Detail |
|---|---|---|
| PASS | Gemini Nano available in the test profile | available |
| PASS | Goal prompt shown on a video with no saved goal | card: chip |
| PASS | Breakdown, first mapped block and first goal-aware pacing all happen before mapping completes | {"submitted":0,"completeS":148,"phase":"ready","blocks":50,"failed":0,"breakdownReadyS":7.4,"firstMappedBlockS":12.5,"firstGoalAwarePacingS":12.5,"firstSpeedChangeS":12.5,"firstReadyThroughS":12.5,"firstReadyThrough":"Ready through 1:03"} |
| PASS | Goal A mapping completed | phase ready, 50 blocks, 0 failed, 148 s |
| PASS | Playback kept running during mapping | t 87 s (was 10 s) |
| PASS | Per-block results recorded for Goal A | 50 blocks |
| PASS | Goal Map click on a mapped region seeks there | expected ≈740 s, got 735 s (map ~13 s per pixel) |
| PASS | Stop ends Goal Mode | goal:status null, map false |
| PASS | Stop keeps the saved goal (Resume shown) | card saved, saved "Understand how LLMs are trained and turned into assistants." |
| PASS | Failed Resume gives visible feedback | card saved, note "Couldn't read this video's captions. Play it for a moment, then try again." |
| PASS | Failed Resume keeps the saved goal and does not pretend Goal Mode is on | saved "Understand how LLMs are trained and turned into assistants.", map false |
| PASS | After reload the saved goal shows with Resume | card saved "🎯 Understand how LLMs are trained and turned into assistants." |
| PASS | After reload mapping does NOT restart | goal:status null, segments 0 |
| PASS | Resume starts mapping | first mapped block 8.2 s after Resume |
| PASS | A successful retry clears the failure message | note null |
| PASS | Goal Map click into an unmapped part seeks there | t 2501 s of 3588 |
| PASS | Seeking into an unmapped part makes it analyzed next | analyzed 36.9 s after the seek; 0 unmapped regions still left between 20% and the seek point (work jumped ahead) |
| PASS | Goal B mapping completed | phase ready, 50 blocks, 1 failed, 281.1 s |
| PASS | Editing the goal saves the new one for this video | "Understand the security risks of LLMs, especially jailbreaks and prompt injection." |
| PASS | Goal A: every block's speed matches the speed table | 50 blocks |
| PASS | Goal A: Key and Important blocks are visible as slow on the map | 24 Key/Important blocks, all in slow regions |
| PASS | Goal B: every block's speed matches the speed table | 49 blocks |
| PASS | Goal B: Key and Important blocks are visible as slow on the map | 10 Key/Important blocks, all in slow regions |
| PASS | Goal B: its security region is named for security | 45:43–56:21: LLM Security Risks; 57:44–58:42: LLM Vulnerabilities |
| PASS | Goal A and Goal B maps differ materially | 45/49 blocks at a different speed, 41 differ by ≥3 in relevance, high-relevance overlap (Jaccard) 0.03 |

## Timings (seconds after Start)

| | Goal A | Goal B |
|---|---|---|
| breakdownReadyS | 7.4 | 25.4 |
| firstMappedBlockS | 12.5 | 28.9 |
| firstGoalAwarePacingS | 12.5 | 28.9 |
| firstSpeedChangeS | 12.5 | 28.9 |
| firstReadyThroughS | 12.5 | 28.9 |
| firstReadyThrough | Ready through 1:03 | Ready through 1:03 |
| completeS | 148 | 281.1 |
| blocks | 50 | 50 |
| failed | 0 | 1 |

## Goal A vs Goal B

```
{"pairs":49,"diffRate":45,"diffRel":41,"highA":24,"highB":10,"highJaccard":0.03}
```

## Long regions and their names

- Goal A 1:03–23:37: **LLM Training Process** · Key · 1–1.75×
- Goal A 50:24–59:49: **LLM Security & Attacks** · Not relevant · 1.75–2×
- Goal B 0:00–45:43: **LLM Model Training** · Not relevant · 1.75–2×
- Goal B 45:43–56:21: **LLM Security Risks** · Key · 1×

### Regions, Goal A

- 0:00–1:03 · LLM Model Details · Relevant · 1.4×
- 1:03–23:37 · LLM Training Process · Key · 1–1.75×
- 23:37–27:17 · LLM Scaling & Performance · Relevant · 1.4×
- 27:17–29:17 · LLM Capabilities & Use · Important · 1.15×
- 29:17–31:58 · LLM Valuation & Economics · Not relevant · 2×
- 31:58–33:08 · LLM Tool Integration · Key · 1×
- 33:08–37:03 · LLM Reasoning & Limitations · Low relevance · 1.75–2×
- 37:03–39:34 · LLM Training & Improvement · Relevant · 1.4×
- 39:34–44:22 · LLM Customization & Architecture · Important · 1–1.4×
- 44:22–49:00 · LLM Ecosystem & Security · Low relevance · 1.75–2×
- 49:00–50:24 · LLM Jailbreaking & Encoding · Key · 1×
- 50:24–59:49 · LLM Security & Attacks · Not relevant · 1.75–2×

### Blocks, Goal A

| Time | R | A | Speed | Topic |
|---|---|---|---|---|
| 0:00–1:03 | 5 | 3 | 1.4 | LLM definition, Llama 2 model details |
| 1:03–2:09 | 7 | 6 | 1.15 | Llama 2 model weights and architecture release |
| 2:09–3:24 | 3 | 6 | 1.75 | Neural network implementation and usage |
| 3:24–4:39 | 7 | 7 | 1 | LLM training: parameters and inference |
| 4:39–6:01 | 8 | 7 | 1 | LLM training process and compression |
| 6:01–7:23 | 7 | 6 | 1.15 | LLM training: next word prediction |
| 7:23–8:36 | 5 | 7 | 1.4 | Next word prediction and compression |
| 8:36–9:51 | 7 | 7 | 1 | LLM training: next word prediction & inference |
| 9:51–10:47 | 7 | 7 | 1 | LLM training: mimicking, hallucination, knowledge |
| 10:47–12:01 | 7 | 7 | 1 | LLM training, Transformer architecture details |
| 12:01–13:21 | 7 | 8 | 1 | LLM training: parameters, knowledge, weirdness |
| 13:21–14:31 | 10 | 7 | 1 | LLM training stages: pre-training, fine-tuning |
| 14:31–15:59 | 10 | 7 | 1 | Assistant model training process overview |
| 15:59–16:59 | 10 | 7 | 1 | LLM training: pre-training, fine-tuning |
| 16:59–17:52 | 10 | 7 | 1 | LLM training: pre-training & fine-tuning |
| 17:52–19:13 | 10 | 7 | 1 | LLM training: pre-training and fine-tuning |
| 19:13–20:35 | 10 | 7 | 1 | LLM training and fine-tuning process |
| 20:35–21:34 | 8 | 7 | 1 | LLM training stages and fine-tuning |
| 21:34–22:21 | 8 | 7 | 1 | Fine-tuning with human feedback |
| 22:21–23:37 | 7 | 6 | 1.15 | Human labeling and LLM collaboration |
| 23:37–24:56 | 5 | 4 | 1.4 | LLM leaderboard and model types |
| 24:56–26:14 | 5 | 7 | 1.4 | Scaling laws and LLM performance prediction |
| 26:14–27:17 | 5 | 6 | 1.4 | LLM training with bigger models and data |
| 27:17–28:15 | 7 | 6 | 1.15 | LLM capabilities, fine-tuning examples |
| 28:15–29:17 | 7 | 6 | 1.15 | LLM using tools like web browsing |
| 29:17–30:31 | 2 | 7 | 2 | LLM valuation and calculator usage |
| 30:31–31:58 | 0 | 3 | 2 | Scale AI valuation analysis using ChatGPT |
| 31:58–33:08 | 7 | 7 | 1 | LLMs using tools, image generation |
| 33:08–34:34 | 3 | 4 | 1.75 | LLMs, tool use, and multimodality capabilities |
| 34:34–35:46 | 2 | 6 | 2 | System 1 vs System 2 thinking in LLMs |
| 35:46–37:03 | 3 | 6 | 1.75 | LLMs lack conscious reasoning, system 1 only |
| 37:03–38:12 | 5 | 7 | 1.4 | LLM training: time, accuracy, self-improvement |
| 38:12–39:34 | 5 | 6 | 1.4 | AlphaGo training: imitation then self-improvement |
| 39:34–40:50 | 7 | 7 | 1 | LLM training: self-improvement and reward |
| 40:50–42:15 | 7 | 6 | 1.15 | LLM customization and fine-tuning overview |
| 42:15–43:27 | 5 | 3 | 1.4 | LLM as operating system kernel |
| 43:27–44:22 | 7 | 6 | 1.15 | LLM context window as working memory |
| 44:22–45:43 | 3 | 7 | 1.75 | LLMs as an operating system ecosystem |
| 45:43–46:57 | 3 | 7 | 1.75 | LLM security challenges: jailbreak attacks |
| 46:57–47:47 | 2 | 7 | 2 | Jailbreak attacks on language models |
| 47:47–49:00 | 3 | 7 | 1.75 | LLM training with base64 encoding |
| 49:00–50:24 | 7 | 7 | 1 | LLM training: jailbreaking and encoding |
| 50:24–51:29 | 2 | 7 | 2 | LLM jailbreaking with adversarial examples |
| 51:29–52:41 | 2 | 5 | 2 | Prompt injection attack example |
| 52:41–53:57 | 2 | 7 | 2 | Prompt injection attacks and LLM vulnerabilities |
| 53:57–55:09 | 2 | 7 | 2 | Prompt injection attack on LLMs |
| 55:09–56:21 | 2 | 7 | 2 | Prompt injection and data exfiltration risks |
| 56:21–57:44 | 3 | 7 | 1.75 | Data poisoning and trigger phrases in LLMs |
| 57:44–58:42 | 3 | 7 | 1.75 | LLM prompt injection attacks |
| 58:42–59:49 | 0 | 2 | 2 | LLM security and evolving attack defenses |

### Regions, Goal B

- 0:00–45:43 · LLM Model Training · Not relevant · 1.75–2×
- 45:43–56:21 · LLM Security Risks · Key · 1×
- 56:21–57:44 · — · Couldn't be analyzed
- 57:44–58:42 · LLM Vulnerabilities · Key · 1×
- 58:42–59:49 · LLM Security Measures · Relevant · 1.4×

### Blocks, Goal B

| Time | R | A | Speed | Topic |
|---|---|---|---|---|
| 0:00–1:03 | 2 | 3 | 2 | LLM definition, Llama 2 model details |
| 1:03–2:09 | 2 | 3 | 2 | Llama 2 model architecture and parameters |
| 2:09–3:24 | 2 | 3 | 2 | LLM architecture and execution |
| 3:24–4:39 | 3 | 6 | 1.75 | LLM training, parameters, inference process |
| 4:39–6:01 | 2 | 3 | 2 | LLM training process: data, GPUs, compression |
| 6:01–7:23 | 2 | 6 | 2 | LLM neural network prediction process |
| 7:23–8:36 | 2 | 7 | 2 | Neural network prediction and compression |
| 8:36–9:51 | 2 | 3 | 2 | LLM training and inference process |
| 9:51–10:47 | 3 | 6 | 1.75 | LLM hallucination and text generation |
| 10:47–12:01 | 2 | 4 | 2 | LLM architecture and word prediction |
| 12:01–13:21 | 3 | 7 | 1.75 | LLM parameters, knowledge, and weirdness |
| 13:21–14:31 | 3 | 4 | 1.75 | LLMs as inscrutable empirical artifacts |
| 14:31–15:59 | 2 | 3 | 2 | Assistant model training process |
| 15:59–16:59 | 2 | 3 | 2 | LLM training: pre-training vs fine-tuning |
| 16:59–17:52 | 3 | 7 | 1.75 | LLM training: pre-training vs fine-tuning |
| 17:52–19:13 | 2 | 5 | 2 | LLM pre-training and fine-tuning process |
| 19:13–20:35 | 2 | 3 | 2 | Fine-tuning LLMs for assistant models |
| 20:35–21:34 | 2 | 3 | 2 | LLM fine-tuning stages and comparison labels |
| 21:34–22:21 | 2 | 3 | 2 | Reinforcement learning from human feedback (RLHF) |
| 22:21–23:37 | 2 | 3 | 2 | Human-AI collaboration in labeling LLMs |
| 23:37–24:56 | 2 | 2 | 2 | LLM leaderboard and model types |
| 24:56–26:14 | 3 | 6 | 1.75 | Scaling laws and LLM performance prediction |
| 26:14–27:17 | 2 | 3 | 2 | LLM model scaling and accuracy improvements |
| 27:17–28:15 | 2 | 3 | 2 | LLM capabilities and fine-tuning examples |
| 28:15–29:17 | 3 | 4 | 1.75 | LLM using browsing tools for information |
| 29:17–30:31 | 0 | 3 | 2 | LLM valuation and calculator usage |
| 30:31–31:58 | 0 | 2 | 2 | Scale AI valuation and extrapolation |
| 31:58–33:08 | 3 | 6 | 1.75 | LLMs using tools, image generation via DALL-E |
| 33:08–34:34 | 2 | 3 | 2 | Multimodality of LLMs: Images, Audio |
| 34:34–35:46 | 2 | 3 | 2 | LLM development directions, system 1/2 thinking |
| 35:46–37:03 | 2 | 3 | 2 | LLM system 1 vs system 2 reasoning |
| 37:03–38:12 | 2 | 3 | 2 | LLM system design and self-improvement |
| 38:12–39:34 | 2 | 3 | 2 | AlphaGo's self-improvement process |
| 39:34–40:50 | 2 | 3 | 2 | LLM self-improvement and reward functions |
| 40:50–42:15 | 2 | 3 | 2 | LLM customization and GPTs App Store |
| 42:15–43:27 | 2 | 3 | 2 | LLM as operating system kernel |
| 43:27–44:22 | 3 | 6 | 1.75 | LLM context window as working memory |
| 44:22–45:43 | 2 | 6 | 2 | LLMs as an operating system ecosystem |
| 45:43–46:57 | 10 | 7 | 1 | LLM security: jailbreak attacks explained |
| 46:57–47:47 | 8 | 7 | 1 | LLM jailbreak via roleplay attack vector |
| 47:47–49:00 | 9 | 7 | 1 | Base64 encoding bypasses safety filters |
| 49:00–50:24 | 10 | 7 | 1 | LLM jailbreaks using universal transferable suffixes |
| 50:24–51:29 | 10 | 7 | 1 | LLM jailbreaks using adversarial examples |
| 51:29–52:41 | 9 | 7 | 1 | Prompt injection attack example |
| 52:41–53:57 | 10 | 7 | 1 | Prompt injection attack example explained |
| 53:57–55:09 | 10 | 8 | 1 | Prompt injection via image URL exfiltration |
| 55:09–56:21 | 7 | 7 | 1 | Google Apps Script exfiltration vulnerability |
| 56:21–57:44 | – | – | – | not mapped (failed) |
| 57:44–58:42 | 7 | 7 | 1 | LLM vulnerabilities: trigger word attacks |
| 58:42–59:49 | 5 | 3 | 1.4 | LLM security: cat and mouse game |

## Screenshots

- goalA-just-started: 01-goalA-just-started.png
- goalA-partially-mapped: 02-goalA-partially-mapped.png
- goalA-completed-map: 03-goalA-completed-map.png
- goalA-tooltip-open: 04-goalA-tooltip-open.png
- resume-failed-feedback: 05-resume-failed-feedback.png
- saved-inactive-after-reload: 06-saved-inactive-after-reload.png
- resumed-partially-mapped-after-seek: 07-resumed-partially-mapped-after-seek.png
- goalB-just-started: 08-goalB-just-started.png
- goalB-partially-mapped: 09-goalB-partially-mapped.png
- goalB-completed-map: 10-goalB-completed-map.png

## Suspicious

- YouTube showed pre-roll ads on 1 load(s); the test waited them out (ViewPace pauses during ads)
