# Goal Mode POC 1.1: evaluation

Branch `feature/goal-mode-poc1` at `e54bc82` (POC 1.1). The Goal Mode algorithm (prompts, blocking,
thresholds, speed mapping, controller) was **not changed** for this evaluation. Raw data and the
generated metric tables are in `eval-results/goal-mode-poc1/`; the harness is in `eval/goal-mode/`.

## Executive summary

**Does Goal Mode respond meaningfully to different goals? Yes, strongly.** When only the goal changes,
a block's relevance changes by 3.7 points on average (range 3.0–4.9 across the 9 goal pairs). 78% of
blocks change by ≥2 points and 64% by ≥3. About 80% of blocks get a different target speed, with a
mean difference of 0.47× on the Normal pace. That is as much goal sensitivity as the independent judge
shows (3.9 points). The most relevant 20% of blocks hardly overlap between goals (Jaccard 0.05,
max 0.22). No pair of goals produced near-identical maps.

**Are the differences semantically sensible? In direction, yes; in magnitude, often not.**
- Goal Mode's relevance tracks the judge's ranking well. Pooled over 387 block × goal ratings,
  Spearman is 0.71 and Pearson 0.73; per run, Pearson ranges from 0.57 to 0.94.
- Goal Mode **never missed** anything the judge considered important. It rated all 63 judge-high
  blocks (judge ≥7) at ≥7 too, and had zero false-lows (Goal Mode ≤3, judge ≥7).
- But it rates far too many blocks as important. Only 36% of its ≥7 ratings were also ≥7 for the
  judge. 87 of its 177 high ratings (49%) went to blocks the judge rated **≤3** (false-highs).
  Mean absolute error is 3.3 points, nearly all of it Goal Mode scoring higher than the judge.

**Are the relevance scores well distributed or bunched?** They are bunched at the high end and use
very few values.
- 46% of all ratings are ≥7, against 16% for the judge. The mean is 5.3, against 2.1.
- Three runs are flagged as high-bunched (median ≥7 or ≥50% of blocks at ≥7): Karpathy/training
  (60% ≥7), 3Blue1Brown/weights (71%) and Git/branches (69%).
- Nano uses essentially five values. Across all ratings: 2 → 80, 3 → 77, 5 → 39, 7 → 99, 10 → 70.
  The values 4, 6, 8 and 9 together were used 15 times.
- "7" works as a default for "related to the subject of the video". It is the most common score.
  Its reasons often hedge ("indirectly related", "but lacks …"), and the judge put most of
  these blocks at 0–2.
- Attention is narrow too: mostly 3–7, never above 8.

**Is latency acceptable for interactive use? Yes, by a wide margin.**
- The first useful pacing decision (the block at 0:00) was ready **2.5–3.7 s** after Start.
- The first 5 minutes of the video were mapped after **10–14 s**.
- Mapping ran at about **26× real time**: one Nano call per block, median 2.6 s, p90 2.7–3.0 s.
- Even at 2× playback, at most 7.5 s of the video played before its block was rated. All of it was
  at the very start; no gaps after that.
- Complete maps took 66 s for 27 minutes of video and 150–158 s for 60–68 minutes.
- No retries and no failed blocks across 387 block calls. 11 of 15 section-grouping calls were
  valid; the other 4 left a window without section labels (display only, no effect on pacing).

**What are the largest failure modes?**
1. **Over-scoring, or "on-topic is relevant".** Content about the video's general subject gets 7–10
   even when it doesn't address the goal:
   - for the goal "LLM tool use / LLM OS", the training and model-file sections got 7;
   - for the goal "SSH keys", Git basics and a closing fork/PR workflow got 7–10;
   - for the goal "undoing changes", merge-conflict resolution got 10.

   Across videos, Goal Mode gave 54 blocks a ≥7 for two or more goals at once; the judge did that
   for **zero** blocks.
2. **Coarse, five-level scoring.** Scores jump between 3, 5, 7 and 10, so relevance has few distinct
   levels. Combined with the pacing thresholds (≥7 means 1.0–1.15×), this sends a large share of
   each video to the slow tiers.
3. **Playback cost.** On Normal, **48% of all slow playback time (≤1.15×) goes to blocks the judge
   rated ≤3**. Goal Mode cuts total watch time from 466 to 342 minutes (−27%); pacing from the
   judge's scores would reach 276 minutes (−41%). Goal Mode never fast-forwarded content the judge
   considered important (0 minutes of judge ≥7 content played at ≥1.75×).
4. Minor: a "video introduction" block was rated 10 for two Git goals (the speaker lists what the
   video will cover). Section grouping fails about one time in four and leaves those blocks
   unlabelled.

**Recommendation: B.** Goal conditioning is real, fast and safe in the important direction (no
missed key content), but relevance is inflated and coarse, so the map isn't yet selective enough.
The full reasoning is at the end.

## Method

### Environment and limitations

- **Hardware:** Apple M1 Pro with 16 GB, Chrome 154.
- **Model:** Gemini Nano through the Prompt API in the extension service worker. Context window
  9,216 tokens; temperature min(0.2, max) and topK min(3, max), as in production.
- **Test browser:** a throwaway Chrome profile launched by hand with remote debugging. An
  automation-launched Chrome gets empty YouTube captions, and the main Chrome profile can't be
  attached on macOS.
- **Transcripts:** captured with ViewPace's own page hook, which copies the player's caption
  response. They are kept in `eval-results/goal-mode-poc1/transcripts/`, so the runs can be repeated
  without YouTube.
- **One run per video × goal.** Nano's variation between repeated runs was not measured. With the
  low temperature and topK it is probably small, but it isn't zero.
- **Scope:** pacing numbers are for the **Normal** pace (1.0–2.0×), and every run starts at 0:00.
- **Harness glitch:** during the first batch the CLI lost its connection to the browser, so two Git
  runs didn't start. They were re-run unchanged. This was a harness problem, not a Goal Mode failure.

### Harness (no second Goal Mode)

`eval/goal-mode/eval-page.ts` is bundled into a git-ignored copy of the built extension
(`dist-eval/`) as an extension page. It calls the **production** modules unchanged:
- `transcriptFromTimedtext`: caption parsing;
- `makeBlocks`: 45–100 s blocks cut at pauses;
- `GoalSession.run`: upcoming-first order, one retry, section windows;
- `NanoGoalAnalyzer`: its requests are answered by the **real background service worker** with the
  production prompts, schemas and validation;
- `goalTarget`: the production speed table, applied to every block.

The only addition is a wrapper around the analyzer that records each call's start and end times,
outcome and errors.

Other scripts:
- `eval/goal-mode/run-all.sh` runs all 9 combinations and saves the raw JSON.
- `eval/goal-mode/analyze.ts` computes every metric below and writes `metrics.json` and `metrics.md`.

### Independent judge

- **Who:** a separate Claude agent (Anthropic Claude, run as a subagent of the session doing this
  evaluation), not Gemini Nano.
- **What it saw:** only `judge/<video>.input.json`, which holds the title, the three goals and the
  plain block text with timestamps. Before the hand-off it was checked that these files contain no
  Goal Mode fields.
- **Isolation:** it was told not to open any other file. It finished before any Goal Mode result
  was analysed.
- **Rubric (0–10):**

  | Score | Meaning |
  |---|---|
  | 0 | unrelated |
  | 1–2 | passing mention |
  | 3–4 | loose context, skippable |
  | 5–6 | useful supporting background |
  | 7–8 | substantially addresses the goal; should watch |
  | 9–10 | core explanation that directly delivers the goal |

  It was asked to judge each block on its own content and to use the full scale.
- **Caveat:** this is a stronger LLM's opinion, **not ground truth**. The judge model is from the
  same family as the evaluator who wrote the goals, and it saw neighbouring blocks for context. The
  judge tends to be strict: 56% of its ratings are 0.

### Metric definitions

- **Top-20% sets:** the ⌈20%⌉ highest-relevance blocks. Ties are broken by attention, then by the
  earlier block. A tie-inclusive variant is also reported, because Goal Mode's coarse scores create
  many ties.
- **Speed:** the production `goalTarget` on Normal. Not relevant 2.0×, less relevant 1.75×,
  background 1.4×, important 1.15×, key part 1.0×.
- **Latency:** measured from the moment `GoalSession.run` starts.
  - **First useful decision** is when the block containing the playhead (0:00) is rated.
  - **Enough for continuous operation** is when the whole first 5 minutes is rated, and is also
    checked by simulating playback at 1× and 2× and summing the seconds played over an unrated
    block.
- **Watch time:** the sum of block duration divided by target speed. The judge-paced figure applies
  the same table to the judge's relevance and Goal Mode's attention.

## Videos and goals

| Video | Length | Captions | Blocks |
|---|---|---|---|
| [[1hr Talk] Intro to Large Language Models](https://www.youtube.com/watch?v=zjkBMFhNj_g) by Andrej Karpathy | 59:50 | auto-generated (ASR), word timing, 12,150 words | 50 |
| [Transformers, the tech behind LLMs, Deep Learning Chapter 5](https://www.youtube.com/watch?v=wjZofJX0v4M) by 3Blue1Brown | 26:52 | uploaded, line timing, 5,137 words | 24 |
| [Git and GitHub for Beginners, Crash Course](https://www.youtube.com/watch?v=RGOj5yH7evk) by freeCodeCamp.org | 68:29 | uploaded, line timing, 11,123 words | 55 |

Goals (exact text):

- **Karpathy**
  - **A:** Understand how large language models are trained, from pretraining on internet text to fine-tuning them into assistants.
  - **B:** Learn about security attacks on language models, such as jailbreaks, prompt injection and data poisoning.
  - **C:** Understand how language models use tools like a web browser, a calculator and code execution, and the idea of an LLM operating system.
- **3Blue1Brown**
  - **A:** Understand how word embeddings represent meaning as directions in a high-dimensional space.
  - **B:** Understand how the softmax function and temperature turn the model's final outputs into a probability distribution.
  - **C:** Understand the general deep learning background: model weights, parameters and matrix-vector multiplication.
- **Git**
  - **A:** Learn how to install Git and connect it to GitHub using SSH keys.
  - **B:** Learn how branches work and how to merge them, including resolving merge conflicts.
  - **C:** Learn how to undo changes and mistakes, for example with git reset.

## Results per video

Abbreviations: GM = Goal Mode, J = judge, R = relevance, A = attention. The full tables, including
the attention histograms, are in `eval-results/goal-mode-poc1/metrics.md`.

### 1. Karpathy, Intro to Large Language Models (50 blocks)

**Score distribution**

| Goal | R mean | R median | R sd | R min–max | R ≥7 | R ≥8 | A mean | A median | A sd | A ≥7 | Bunched? |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A: training | 5.66 | 7 | 3.15 | 0–10 | 60% | 22% | 6.46 | 7 | 1.14 | 70% | **yes** |
| B: security | 4.28 | 3 | 3.24 | 0–10 | 26% | 22% | 5.28 | 6 | 1.69 | 30% | no |
| C: tools / LLM OS | 5.46 | 5 | 2.65 | 0–10 | 42% | 18% | 6.56 | 7 | 1.02 | 74% | no |

**Relevance histograms** (number of blocks scoring 0…10)

| Goal | Goal Mode | Judge |
|---|---|---|
| A | `4 1 6 7 0 2 0 19 2 0 9` | `16 8 5 5 2 2 0 4 4 4 0` |
| B | `3 0 15 17 0 2 0 2 0 1 10` | `38 0 0 0 0 1 0 0 3 8 0` |
| C | `1 0 6 10 0 11 1 12 2 0 7` | `30 8 2 0 2 1 0 0 1 6 0` |

**Goal sensitivity**

| Pair | mean abs ΔR | ΔR ≥2 | ΔR ≥3 | top-20% Jaccard (ties incl.) | speed differs | mean abs Δspeed (time-weighted) | judge mean abs ΔR | judge Jaccard |
|---|---|---|---|---|---|---|---|---|
| A–B | 4.86 | 86% | 82% | 0.00 (0.00) | 90% | 0.64× (0.64×) | 4.68 | 0.00 |
| A–C | 3.20 | 76% | 62% | 0.00 (0.14) | 72% | 0.37× (0.38×) | 4.32 | 0.00 |
| B–C | 4.10 | 84% | 62% | 0.05 (0.15) | 82% | 0.53× (0.53×) | 3.44 | 0.00 |

**Agreement with the judge and effect on playback**

| Goal | Pearson | Spearman | MAE | GM ≥7 | J ≥7 | both ≥7 | false-high | false-low | watch time: 1× → GM / judge-paced | slow time on J ≤3 |
|---|---|---|---|---|---|---|---|---|---|---|
| A | 0.76 | 0.80 | 2.80 | 30 | 12 | 12 | 14 | 0 | 59.8 → 47.4 / 38.0 min | 44% |
| B | 0.94 | 0.76 | 2.26 | 13 | 11 | 11 | 1 | 0 | 59.8 → 39.0 / 36.6 min | 6% |
| C | 0.68 | 0.51 | 3.80 | 21 | 7 | 7 | 11 | 0 | 59.8 → 45.8 / 34.6 min | 53% |

Goal B (security) is close to ideal. The attack section is a distinct, late part of the talk, and
Goal Mode scores it 9–10 and nearly everything else 2–3. Goals A and C are inflated: much of the
talk "relates to LLMs", so it gets 7. For example, the training blocks got 7 for the tool-use goal,
and the jailbreak blocks got 7 for the training goal. **Latency:** first decision 2.7–3.6 s, first
5 minutes mapped after 13–14 s, all 50 blocks rated after 139–148 s. **Sections:** 4 of 6 grouping
calls were valid. For goals A and B, the 10-block second window (40:40 onward) has no section labels.

### 2. 3Blue1Brown, Transformers (24 blocks)

**Score distribution**

| Goal | R mean | R median | R sd | R min–max | R ≥7 | R ≥8 | A mean | A median | A sd | A ≥7 | Bunched? |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A: embeddings | 5.58 | 5 | 2.97 | 2–10 | 42% | 25% | 5.42 | 6 | 1.89 | 46% | no |
| B: softmax / temperature | 4.17 | 2.5 | 3.13 | 0–10 | 29% | 17% | 4.17 | 3 | 1.82 | 25% | no |
| C: weights / matrix-vector | 6.50 | 7 | 1.80 | 3–10 | 71% | 17% | 5.67 | 6 | 1.55 | 38% | **yes** |

**Relevance histograms** (0…10)

| Goal | Goal Mode | Judge |
|---|---|---|
| A | `0 0 2 9 0 3 0 4 0 0 6` | `12 2 2 0 1 0 3 0 1 1 2` |
| B | `1 0 11 4 0 1 0 3 0 0 4` | `14 0 3 3 0 0 1 1 0 0 2` |
| C | `0 0 0 3 0 4 0 13 2 0 2` | `2 8 2 3 3 2 0 1 1 1 1` |

**Goal sensitivity**

| Pair | mean abs ΔR | ΔR ≥2 | ΔR ≥3 | top-20% Jaccard (ties incl.) | speed differs | mean abs Δspeed (time-weighted) | judge mean abs ΔR | judge Jaccard |
|---|---|---|---|---|---|---|---|---|
| A–B | 4.00 | 67% | 58% | 0.00 (0.00) | 88% | 0.53× (0.53×) | 4.21 | 0.00 |
| A–C | 3.17 | 88% | 58% | 0.11 (0.28) | 83% | 0.39× (0.40×) | 4.17 | 0.00 |
| B–C | 3.83 | 88% | 79% | 0.00 (0.26) | 88% | 0.54× (0.54×) | 3.71 | 0.08 |

**Agreement with the judge and effect on playback**

| Goal | Pearson | Spearman | MAE | GM ≥7 | J ≥7 | both ≥7 | false-high | false-low | watch time: 1× → GM / judge-paced | slow time on J ≤3 |
|---|---|---|---|---|---|---|---|---|---|---|
| A | 0.85 | 0.81 | 3.04 | 10 | 4 | 4 | 2 | 0 | 26.9 → 20.4 / 16.5 min | 21% |
| B | 0.87 | 0.91 | 2.17 | 7 | 3 | 3 | 3 | 0 | 26.9 → 18.0 / 15.8 min | 43% |
| C | 0.59 | 0.56 | 3.38 | 17 | 4 | 4 | 9 | 0 | 26.9 → 22.5 / 16.4 min | 50% |

Rankings are good for A and B (Spearman 0.81 and 0.91). Goal C is a "background" goal (weights,
parameters, matrix-vector products), and Nano scores almost the whole video at 7 for it (71% ≥7,
never below 3). The judge sees one concentrated stretch (10:17–12:27). **Latency:** first decision
2.5–3.3 s, first 5 minutes mapped after 13–14 s, the whole video after 61–62 s. **Sections:** all 3
grouping calls were valid.

### 3. freeCodeCamp, Git and GitHub crash course (55 blocks)

**Score distribution**

| Goal | R mean | R median | R sd | R min–max | R ≥7 | R ≥8 | A mean | A median | A sd | A ≥7 | Bunched? |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A: install + SSH | 5.04 | 3 | 2.91 | 0–10 | 45% | 15% | 5.38 | 6 | 1.24 | 18% | no |
| B: branches / merge | 6.67 | 7 | 3.00 | 1–10 | 69% | 35% | 4.87 | 5 | 1.56 | 18% | **yes** |
| C: undo / reset | 4.51 | 3 | 2.70 | 0–10 | 29% | 11% | 4.51 | 4 | 1.41 | 11% | no |

**Relevance histograms** (0…10)

| Goal | Goal Mode | Judge |
|---|---|---|
| A | `1 0 13 14 0 2 0 17 0 0 8` | `35 8 2 4 1 0 0 0 0 2 3` |
| B | `0 1 9 4 0 3 0 19 1 0 18` | `25 5 0 2 3 3 4 3 5 4 1` |
| C | `1 0 18 9 0 11 0 10 0 0 6` | `46 3 1 0 0 0 1 0 0 0 4` |

**Goal sensitivity**

| Pair | mean abs ΔR | ΔR ≥2 | ΔR ≥3 | top-20% Jaccard (ties incl.) | speed differs | mean abs Δspeed (time-weighted) | judge mean abs ΔR | judge Jaccard |
|---|---|---|---|---|---|---|---|---|
| A–B | 3.89 | 76% | 67% | 0.05 (0.13) | 71% | 0.46× (0.46×) | 4.38 | 0.00 |
| A–C | 3.47 | 69% | 51% | 0.00 (0.14) | 80% | 0.47× (0.46×) | 2.24 | 0.22 |
| B–C | 2.96 | 71% | 56% | 0.22 (0.31) | 65% | 0.31× (0.30×) | 3.71 | 0.24 |

**Agreement with the judge and effect on playback**

| Goal | Pearson | Spearman | MAE | GM ≥7 | J ≥7 | both ≥7 | false-high | false-low | watch time: 1× → GM / judge-paced | slow time on J ≤3 |
|---|---|---|---|---|---|---|---|---|---|---|
| A | 0.57 | 0.70 | 3.80 | 25 | 5 | 5 | 20 | 0 | 68.5 → 48.5 / 37.7 min | 78% |
| B | 0.63 | 0.66 | 3.78 | 38 | 13 | 13 | 16 | 0 | 68.5 → 54.3 / 43.7 min | 42% |
| C | 0.64 | 0.48 | 3.58 | 16 | 4 | 4 | 11 | 0 | 68.5 → 46.4 / 36.6 min | 70% |

This is the weakest video. A beginner tutorial is all "Git", so Nano scores generic Git workflow
blocks 7–10 for any Git goal. Blocks with ≥7 for two or more goals: 26 of 55. Goal Mode still
finds the target parts: SSH key blocks get 10 for goal A and 0–2 for goal C. Judge-high blocks were
always rated high. But 78% of goal A's slow time goes to blocks the judge rated ≤3. **Latency:** first decision 2.6–3.7 s,
first 5 minutes mapped after 10–12 s, the whole video after 148–153 s. **Sections:** 4 of 6 calls
were valid. Goal B has no labels for blocks 0–39, and goal C none for blocks 40–54.

## Cross-video summary

Pooled over 9 runs, 387 block ratings and 9 goal pairs:

| Metric | Goal Mode | Judge (reference) |
|---|---|---|
| Mean abs relevance difference between goals | **3.72** (range 2.96–4.86) | 3.87 (2.24–4.68) |
| Blocks with ΔR ≥2 / ≥3 between goals | 78% / 64% | not computed |
| Top-20% Jaccard between goals | 0.05 (ties incl. 0.16), max 0.22 | 0.06, max 0.24 |
| Blocks with a different target speed between goals | 80% (65–90%) | not applicable |
| Mean abs target-speed difference | 0.47× (time-weighted 0.47×) | not applicable |
| Relevance mean / median | 5.30 / 5 | 2.12 / 0 |
| Ratings ≥7 / ≥8 | 45.7% / 20.2% | 16.3% / 14.0% |
| Relevance histogram 0…10 | `11 2 80 77 0 39 1 99 7 1 70` | `218 42 17 17 12 9 9 9 15 26 13` |
| Runs flagged high-bunched | 3 of 9 | not applicable |
| Correlation with judge (Pearson / Spearman) | 0.73 / 0.71 | not applicable |
| MAE against judge | 3.26 | not applicable |
| Judge-high blocks also high in GM (recall) | **63 / 63 (100%)** | not applicable |
| GM-high blocks also high for judge (precision) | **63 / 177 (36%)** | not applicable |
| False-high (GM ≥7, J ≤3) / false-low (GM ≤3, J ≥7) | **87 / 0** | not applicable |
| Blocks rated ≥7 for two or more goals of the same video | 54 / 129 | **0 / 129** |
| Watch time on Normal (1× = 465.5 min) | 342.3 min (−27%) | judge-paced 276.0 min (−41%) |
| Slow time (≤1.15×) spent on judge ≤3 blocks | 95.5 of 198.9 min (**48%**) | not applicable |
| Judge-high content played at ≥1.75× | **0 min** | not applicable |

**Latency (9 runs):**

| Measure | Mean | Range |
|---|---|---|
| Start → first completed block | 2.98 s | 2.54–3.72 s |
| Start → first useful decision (block at playhead 0:00) | 2.98 s | 2.54–3.72 s |
| Start → first 5 minutes mapped | 12.6 s | 9.9–14.0 s |
| Content mapped per wall-clock second | 26.3× | 24.2–27.8× |
| Unmapped playback at 1× / 2× (only at the very start) | not computed | ≤3.7 s / ≤7.5 s |
| Start → all blocks rated | 118 s | 61–153 s |
| Start → complete map (including sections) | not computed | 66–158 s |
| Block call median / p90 | 2.57 s / ≈2.8 s | not computed |

**Counts:**

| Measure | Value |
|---|---|
| Blocks | 387 |
| Block calls | 387 |
| Retries | 0 |
| Failed blocks | 0 |
| Section calls | 15 (11 valid, 4 rejected by validation) |

## Interesting examples

### Goal changes caused the desired relevance change

| Block | Goal Mode R (A/B/C) | Judge (A/B/C) | Speed (A/B/C) |
|---|---|---|---|
| Karpathy #12, 14:31–15:59, "and this is where we obtain what we call an assistant model…" | 10 / 2 / 7 | 9 / 0 / 0 | 1.0× / 2.0× / 1.15× |
| 3Blue1Brown #9, 10:17–11:06, "In deep learning, these model parameters are almost always referred to as weights…" | 3 / 2 / 10 | 0 / 0 / 10 | 1.75× / 2.0× / 1.0× |
| Git #16, 20:33–21:56, "you're going to have to prove to GitHub that you are the owner of your account" | 10 / 2 / 0 | 10 / 0 / 0 | 1.0× / 2.0× / 2.0× |
| Karpathy #41, 49:00–50:24, jailbreaking with encoded text and universal suffixes | 7 / 10 / 7 | 1 / 9 / 0 | 1.0× / 1.0× / 1.0× |

In the first three, the same block is key for one goal and fast-forwarded for another, exactly as
intended. For Karpathy #12 the reasons show the conditioning: "Directly explains how assistant
models are created, crucial for the goal" for A, and "indirectly relevant to attacks" for B.

Karpathy #41 is the partial case: the right goal is highest, but the other two goals still get 7.

### Goals unexpectedly produced similar scores

| Block | Goal Mode R (A/B/C) | Judge (A/B/C) | What happened |
|---|---|---|---|
| Git #31, 39:30–41:06, demo of modify → add → commit on a branch | 7 / 7 / 7 | 0 / 8 / 0 | Three goals, three plausible-sounding 7s: "Shows basic Git workflow… but doesn't cover SSH keys", "…relevant to merging", "…relevant to undoing mistakes" |
| 3Blue1Brown #22, 25:06–26:03, temperature above 2 and logits | 7 / 7 / 7 | 0 / 7 / 1 | The block is about temperature (goal B), but embeddings (A) and matrix-vector products (C) also get 7 |
| Git #0, 0:00–1:27, "In this video we are going to learn about Git and GitHub…" | 10 / 10 / 7 | 1 / 1 / 0 | The table-of-contents intro is scored as "directly defines Git, core to the viewer's goal" |

### Goal Mode strongly disagreed with the judge

| Block | Goal | Goal Mode (R/A, speed, reason) | Judge |
|---|---|---|---|
| Karpathy #27, 31:58–33:08, "the crucial point that I want to demonstrate… is the tool use aspect" | A: training | R7/A6, 1.15×, "Illustrates LLM's ability to use external tools, relevant to training and fine-t[uning]" | 0 |
| Karpathy #3, 3:24–4:39, running the model on a MacBook with two files | C: tools / LLM OS | R7/A7, 1.0×, "Explains training, a key part of understanding LLMs, but lacks tool use details" | 0 |
| 3Blue1Brown #4, 4:29–5:53, MLP / feed-forward layer | B: softmax | R10/A7, 1.0×, "Directly describes the softmax operation's purpose" | 3 |
| Git #47, 59:22–60:37, `git log` and undoing the last commit | B: branches | R10/A7, 1.0×, "Directly explains commit history and undoing merges using hashes, core goal" | 0 |
| Git #43, 54:35–56:07, "now it says we have a conflict…" | C: undo / reset | R10/A7, 1.0×, "Directly addresses conflict resolution, core to undoing mistakes" | 0 |
| Git #54, 67:29–68:28, closing fork → pull → PR workflow | A: install + SSH | R10/A7, 1.0×, "Describes a core Git workflow, directly relevant to the goal" | 0 |

In the Karpathy #3 case, the reason itself says the block lacks what the goal asks for, yet the score
is 7. This pattern recurs.

No reverse cases exist: Goal Mode never put a judge-high block at ≤3.

### Relevance was unexpectedly high or low

- **Unexpectedly high:**
  - "Background" goals pull in whole videos. 3Blue1Brown goal C never scores below 3 and has 71%
    of blocks at ≥7.
  - Generic tutorial content counts as relevant to every Git goal (Git goal B: 69% ≥7).
  - Hedged reasons ("indirectly", "but lacks …") still come with 7.
- **Unexpectedly low:** none found. The lowest scores always went to blocks the judge also rated low.

## Recommendation

**B: POC 1 shows promise but needs a specific scoring/calibration fix before POC 2.**

Why not C:
- Goal conditioning is real and reliable. Changing only the goal moves relevance by as much as the
  judge's own goal-to-goal differences (3.7 vs 3.9 points), changes the target speed for about 80%
  of blocks, and produces almost disjoint top-block sets in every video.
- The direction is sensible: rankings correlate well with an independent judge (Spearman 0.71).
- Not one judge-important block was scored low or fast-forwarded.
- Latency is not an obstacle: the first useful decision comes in about 3 s, and mapping runs at
  about 26× real time with no failures.

Why not A:
- The scores are poorly calibrated. Only 36% of Goal Mode's "important" ratings are important to the
  judge, and 49% of them the judge considers essentially irrelevant (≤3).
- Nano uses about five discrete values, with 7 as a catch-all for "on the video's subject". Three of
  nine runs are bunched at the high end.
- With the current pacing table, nearly half of all slow playback is spent on content the judge
  rated irrelevant, and watch time savings are 27% instead of a possible ~41%.
- POC 2 adds frames to the relevance signal, which would build on an inflated base score. The
  over-scoring should be understood and fixed first.

The fix this points to is **narrow**: calibrate the block relevance scale so that "on the video's
subject but not on the goal" stops landing at 7, and get real use of the 4/6/8/9 values. It is not
a redesign of blocking, latency or goal conditioning. Rate the change against this same dataset
(the harness, transcripts and blind judge scores are reusable), and check recall against the judge
alongside precision, because "no missed key content" is the property to keep.
