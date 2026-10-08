# Goal Mode POC 1.3A: categorical relevance, evaluated against POC 1.1

POC 1.1 is the numeric baseline, documented in [goal-mode-poc1-evaluation.md](goal-mode-poc1-evaluation.md).
Same Gemini Nano, the same 387 block ratings (3 videos × 3 goals, identical blocks) and the same
saved blind judge scores. The only change is that Nano **picks a relevance category** instead of
giving a 0–10 score.

## Summary

**Categorical relevance does not improve calibration.**

| Measure | POC 1.1 | POC 1.3A |
|---|---|---|
| High-relevance precision | 0.36 | 0.35 |
| High-relevance recall | 1.00 | 0.95 |
| False-highs | 87 | 91 |
| Correlation with judge (Pearson) | 0.73 | 0.68 |
| Share of blocks in the top two classes | 45.7% (≥7) | 44.7% (important or essential) |

In 1.3A, "high" means `important` or `essential`.

**Does Nano still bunch into the upper categories? Yes, and the distribution is bimodal.**

| Category | Share of 387 ratings |
|---|---|
| irrelevant | 2.6% |
| background | 47.5% |
| useful | 5.2% |
| important | 22.7% |
| essential | 22.0% |

Nano almost never uses `irrelevant` or `useful`. Content it considers off-goal goes to `background`,
and content it considers on-topic goes to `important` or `essential`.

**Are the categories themselves meaningful? Only `essential` is.**
- Blocks rated `essential` average 6.2 with the judge, and 59% of them are judge-high.
- Blocks rated `important` average **2.2** with the judge, and 76% of them are judge ≤3.

`important` is where "on the video's subject" now lands, so it carries the same failure as the old
score of 7. I'm reporting this, not acting on it: no mapping was tuned.

**Does goal conditioning survive? Yes, but weaker.**
- The mean goal-to-goal difference falls from 3.72 to 3.13.
- Blocks whose speed changes with the goal fall from 80% to 57%.
- Top-block overlap between goals rises: tie-inclusive Jaccard 0.16 → 0.25, max 0.56.

Most low-relevance blocks now share a single label (`background`) across goals, so goals are told
apart less often.

**Playback gets slightly worse.**
- Watch-time reduction is 23.7% instead of 26.5%.
- 52% of slow playback is spent on content the judge rated ≤3, instead of 48%.
- 1.4 minutes of judge-high content is now played fast.

**Latency and reliability are unchanged:** first decision in 2.6 s on average, 0 retries,
0 failed blocks.

**Recommendation: C.** The details are at the end.

> **A correction to POC 1.2.** While running this experiment I found a harness flaw that very
> likely invalidated the POC 1.2 runs: Chrome kept serving a cached older service worker. A
> corrected rerun of POC 1.2 is described [below](#correction-poc-12-very-likely-ran-the-old-prompt).
> This POC 1.3A result is not affected; the checks are described under Method. The corrected 1.2
> rerun gives the same answer: no precision gain (0.34).

## The change

Production code: `src/shared/goal-prompt.ts`. Nothing else in `src/` changed.

1. **Prompt:** the long POC 1.2 relevance rubric is removed. The relevance bullet now asks for a
   category, using your definitions word for word, plus one instruction ("Judge contribution to the
   stated goal, not general topical similarity"). There are no examples. The attention, topic and
   reason lines and the rest of the prompt are unchanged from POC 1.1.

   ```
   - relevance: what the excerpt contributes to the viewer's stated goal. Judge contribution to the stated goal, not general topical similarity. Choose exactly one:
     irrelevant = does not help achieve the viewer's stated goal; it may still be about the video's general topic.
     background = indirect context that may help, but the viewer could skip it without losing information directly needed for the goal.
     useful = directly helps the viewer achieve the goal.
     important = contains important information for achieving the goal.
     essential = contains core information; skipping it would materially hurt the viewer's ability to achieve the goal.
   ```

2. **Schema:** `relevance` changes from `{type: 'integer', 0–10}` to
   `{type: 'string', enum: [irrelevant, background, useful, important, essential]}`. Field order
   (topic, relevance, attention, reason) is unchanged, and no fields were added.

3. **Parsing:** the category is trimmed and lowercased. Anything else (an unknown word, a number,
   a missing value) throws, so the existing single retry applies and the block stays unmapped if
   that also fails.

4. **Fixed mapping** `RELEVANCE_VALUE`: irrelevant 2, background 3, useful 5, important 7,
   essential 10.
   - `BlockRating.relevance` stays numeric, so the speed table, controller, map, UI and evaluation
     thresholds are untouched.
   - The model's choice is kept as `BlockRating.relevanceCategory` and saved per block in the
     evaluation output.
   - The resulting speeds on Normal:

     | Category | Speed | Label |
     |---|---|---|
     | irrelevant | 2.0× | Not relevant |
     | background | 1.75× | Less relevant |
     | useful | 1.4× | Relevant background |
     | important | 1.15× | Important |
     | important with attention ≥7 | 1.0× | Key part |
     | essential | 1.15× | Important |
     | essential with attention ≥7 | 1.0× | Key part |

**Tests:** 158 pass (153 before). New or updated tests:
- `test/goal-prompt.test.ts`:
  - each category parses and is kept;
  - the mapping table is fixed;
  - case and whitespace are tolerated;
  - unknown, numeric or missing categories are rejected;
  - attention is still clamped;
  - the schema and prompt ask for a category with the field order unchanged.
- `test/goal-session.test.ts`:
  - the fake analyzer now returns parsed **categorical model output**, so all existing lifecycle
    tests run through the categorical path: stale results after navigation, video change, stop,
    holding while mapping, never overriding a speed the user chose, failed parts holding, and
    section labels;
  - each category maps to the unchanged speed table;
  - an invalid category is retried once and the block then stays unmapped.

## Method

- **Same evaluation:** `eval/goal-mode/eval-page.ts` calls the production modules and the
  production service worker. The material is the same transcripts, `makeBlocks` boundaries, goals
  and saved Claude judge scores, with no relabelling. Hardware and settings: M1 Pro, Chrome 154,
  Normal pace, start at 0:00.
- **One run:** the full dataset was run once. The definitions, prompt and mapping were not edited
  after seeing results.
- **Proof that the categorical code actually ran:** every one of the 387 saved block ratings carries
  `relevanceCategory`, which only the new parser produces. A test call before the runs also returned
  a category.
- **Harness changes, evaluation code only:**
  - The chrome-devtools CLI lost its browser connection twice mid-run and closed the eval
    page. Interrupted runs were discarded and rerun; no partial run was kept.
  - The rest of the batch ran through a new direct DevTools-protocol runner,
    `eval/goal-mode/run-cdp.ts`. It drives the same eval page and saves the same output format.
- **Files:**
  - raw runs: `eval-results/goal-mode-poc1.3a/runs/`;
  - per-video tables: `eval-results/goal-mode-poc1.3a/metrics.{json,md}`;
  - before/after comparison, category tables and every example per category:
    `eval-results/goal-mode-poc1.3a/compare.{json,md}`.

## Before / after

The judge is a Claude agent and an approximate reference, not ground truth. "High" means ≥7 for
POC 1.1 and `important` or `essential` for POC 1.3A.

| Metric | POC 1.1 (0–10 score) | POC 1.3A (category) |
|---|---|---|
| **Precision** (Goal Mode high that the judge rates high) | **0.36** (63/177) | **0.35** (60/173) |
| **Recall** (judge high that Goal Mode rates high) | **1.00** (63/63) | **0.95** (60/63) |
| **False-high** (Goal Mode high, judge ≤3) | **87**: 49.2% of Goal Mode high, 22.5% of all ratings | **91**: 52.6% of Goal Mode high, 23.5% of all ratings |
| False-low (Goal Mode ≤3, judge ≥7) | 0 | 2 |
| Pearson / Spearman with judge | 0.73 / 0.71 | 0.68 / 0.67 |
| MAE / mean signed error | 3.26 / +3.18 | 3.54 / +3.40 |
| Relevance mean / median / sd (numeric equivalent) | 5.30 / 5 / 3.02 | 5.52 / 3 / 2.87 |
| Share high / share ≥8 | 45.7% / 20.2% | 44.7% / 22.0% (`essential`) |
| Histogram 0…10 | `11 2 80 77 0 39 1 99 7 1 70` | `0 0 10 184 0 20 0 88 0 0 85` |
| Runs flagged high-bunched | 3 of 9 | 4 of 9 |
| Blocks high for 2 or more goals (of 129) | 54 | 54 |
| Attention mean (rubric unchanged) | 5.41 | 5.31 |

### Category distribution

| Category | Count | Share | Judge mean | Judge ≤3 | Judge ≥7 |
|---|---|---|---|---|---|
| irrelevant | 10 | 2.6% | 0.1 | 10 | 0 |
| background | 184 | **47.5%** | 0.35 | 179 | 2 |
| useful | 20 | 5.2% | 2.05 | 14 | 1 |
| important | 88 | **22.7%** | **2.15** | **67** | 10 |
| essential | 85 | **22.0%** | **6.18** | 24 | **50** |

Per run (irrelevant / background / useful / important / essential):

| Run | Categories | Judge ≥7 |
|---|---|---|
| Karpathy A: training | 5 / 12 / 1 / 23 / 9 | 12 |
| Karpathy B: security | 1 / 36 / 1 / 1 / 11 | 11 |
| Karpathy C: tools / LLM OS | 0 / 15 / 3 / 26 / 6 | 7 |
| 3Blue1Brown A: embeddings | 0 / 13 / 0 / 5 / 6 | 4 |
| 3Blue1Brown B: softmax | 0 / 16 / 1 / 3 / 4 | 3 |
| 3Blue1Brown C: weights | 0 / 7 / 3 / 12 / 2 | 4 |
| Git A: install + SSH | 1 / 32 / 2 / 6 / 14 | 5 |
| Git B: branches | 0 / 15 / 5 / 10 / 25 | 13 |
| Git C: undo / reset | 3 / 38 / 4 / 2 / 8 | 4 |

What this shows:
- **Nano uses the scale as two buckets.** Five labels became "background" or "important/essential";
  `irrelevant` and `useful` together are 8%. Even blocks the judge rated 0 almost always get
  `background`, never `irrelevant`. That maps to 1.75×, not 2.0×.
- **Upper-category bunching is the same as before:** 44.7% of blocks are `important` or
  `essential`, against 45.7% scored ≥7 before.
- **`important` is not a meaningful category.** Three in four of its blocks are judge ≤3. It
  behaves exactly like the old 7: "about the video's subject".
- **`essential` is meaningful.** It holds 50 of the 63 judge-high blocks, at 59% precision. This is
  the one positive signal in the run. Using it would mean changing the category → pacing mapping,
  which this experiment forbids, so it is reported only, not tested or tuned.

### Goal sensitivity

| Metric (means over 9 goal pairs) | POC 1.1 | POC 1.3A |
|---|---|---|
| Mean abs difference between goals (numeric equivalent) | 3.72 | 3.13 |
| Blocks with ΔR ≥2 / ≥3 | 78.2% / 64.0% | 65.3% / 60.6% |
| Blocks changing category between goals | not applicable | 66.2% |
| Blocks with a different target speed | **79.9%** | **57.4%** |
| Mean abs target-speed difference | 0.47× | 0.39× |
| Top-20% Jaccard (ties incl.), mean / max | 0.05 (0.16) / 0.31 | 0.08 (0.25) / 0.56 |
| High-set Jaccard (≥7, or important/essential), mean / max | 0.23 / 0.35 | 0.27 / 0.56 |

Goal conditioning is still clearly present: 58 blocks swing three or more categories across goals,
with examples below. It is weaker than with numeric scoring. The main cause is the `background`
collapse: a block that is off-goal for two goals gets `background` for both, so goals are no longer
told apart there.

### Playback impact (Normal pace, 465.5 min of video)

| Metric | POC 1.1 | POC 1.3A |
|---|---|---|
| Watch time with Goal Mode | 342.3 min (−26.5%) | 355.3 min (−23.7%) |
| Watch time with judge-based pacing (reference) | 276.0 min | 277.6 min |
| Slow playback (≤1.15×) | 198.9 min | 205.3 min |
| …of which on judge ≤3 content | **48.0%** | **52.3%** |
| Judge-high content played at ≥1.75× | 0 min | 1.4 min |

The stricter-sounding categories did **not** make ViewPace spend less slow time on irrelevant
content; it spends slightly more. Content that is truly off-goal now plays at 1.75× (`background`)
instead of 2.0×, so savings are also smaller.

### Latency and failures

| Metric | POC 1.1 | POC 1.3A |
|---|---|---|
| Start → first useful decision, mean (max) | 2.98 s (3.72) | 2.58 s (2.91) |
| Start → first 5 minutes mapped | 12.6 s | 11.7 s |
| Block call median | 2.57 s | 2.48 s |
| Mapping speed | 26.3× real time | 26.7× real time |
| Retries / failed blocks / invalid categories | 0 / 0 / not applicable | 0 / 0 / 0 |
| Valid section groupings | 11 / 15 | 7 / 15 |

The schema constrains Nano to the five values, so it never produced an invalid category. Section
groupings are display only, and the section prompt is unchanged. Their validity varies between runs
because the per-block topic strings they are built from vary (POC 1.2 also had 7 of 15).

### Per video

| Video | Pearson per goal (A/B/C), 1.1 → 1.3A | Speed differs between goals | Watch-time reduction | Slow time on judge ≤3 |
|---|---|---|---|---|
| Karpathy | 0.76/0.94/0.68 → 0.66/**0.99**/0.45 | 81% → 55% | 26.3% → 21.3% | 39% → 54% |
| 3Blue1Brown | 0.85/0.87/0.59 → 0.83/0.87/0.47 | 86% → 57% | 24.6% → 23.2% | 39% → 42% |
| Git | 0.57/0.63/0.64 → 0.59/0.51/0.70 | 72% → 60% | 27.4% → 25.9% | 59% → 56% |

Precision, recall and false-highs per run:

| Run | Judge ≥7 | 1.1: GM high / precision / recall / false-highs | 1.3A: GM high / precision / recall / false-highs |
|---|---|---|---|
| Karpathy A: training | 12 | 30 / 0.40 / 1.00 / 14 | 32 / 0.34 / 0.92 / 17 |
| Karpathy B: security | 11 | 13 / 0.85 / 1.00 / 1 | 12 / **0.92** / 1.00 / **0** |
| Karpathy C: tools / LLM OS | 7 | 21 / 0.33 / 1.00 / 11 | 32 / 0.19 / 0.86 / **24** |
| 3Blue1Brown A: embeddings | 4 | 10 / 0.40 / 1.00 / 2 | 11 / 0.36 / 1.00 / 3 |
| 3Blue1Brown B: softmax | 3 | 7 / 0.43 / 1.00 / 3 | 7 / 0.43 / 1.00 / 3 |
| 3Blue1Brown C: weights | 4 | 17 / 0.24 / 1.00 / 9 | 14 / 0.21 / 0.75 / 8 |
| Git A: install + SSH | 5 | 25 / 0.20 / 1.00 / 20 | 20 / 0.25 / 1.00 / 15 |
| Git B: branches | 13 | 38 / 0.34 / 1.00 / 16 | 35 / 0.37 / 1.00 / 16 |
| Git C: undo / reset | 4 | 16 / 0.25 / 1.00 / 11 | 10 / **0.40** / 1.00 / **5** |

Some runs improve: Karpathy B and Git C. Others get worse, especially Karpathy C, where most of the
talk became `important` for the tool-use / LLM OS goal. Overall the changes cancel out.

## Examples

All examples per category are listed in `eval-results/goal-mode-poc1.3a/compare.md`. "J" is the
judge's score; "old" is the POC 1.1 score.

### Old numeric false-highs now classified lower: 20 of 87

| Block | J | Old → new | Reason |
|---|---|---|---|
| Git A (SSH) #1, 1:27–2:40, "what is version control?…" | 1 | 7 → `background` | "Explains version control, foundational to Git, but not installation." |
| Git C (undo) #26, 33:37–34:47, how a feature branch diverges from master | 0 | 7 → `background` | "Explains branch isolation, not undoing mistakes." |
| Karpathy A (training) #36, 43:27–44:22, LLM OS diagram | 0 | 7 → `background` | "Explains LLM architecture analogy, not training process." |
| Karpathy B (security) #8, 9:51–10:47, hallucinated ISBN | 0 | 7 → `background` | "Illustrates LLM's tendency to generate plausible but incorrect information." |
| 3Blue1Brown A (embeddings) #21, 23:30–25:06, softmax and sampling | 0 | 7 → `background` | "Discusses sampling techniques, indirectly related to embedding space exploration" |

When Nano does reject a block, the reason now matches the label: "…not installation", "…not
undoing mistakes".

### False-highs that remain or are new: 91 in total, including 24 new

| Block | J | Old → new | Reason |
|---|---|---|---|
| Karpathy C (tools / LLM OS) #0, 0:00–1:03, "hi everyone so recently I gave a 30-minute talk…" | 0 | 5 → **`essential`** | "Defines LLMs and introduces a specific, important model." |
| Karpathy C (tools / LLM OS) #15, 17:52–19:13, the two stages of training | 0 | 5 → `important` | "Explains core LLM development process; foundational knowledge." |
| Karpathy C (tools / LLM OS) #42, 50:24–51:29, universal-suffix jailbreak | 1 | 2 → `important` | "Explains a method to bypass LLM safety mechanisms." |
| Karpathy A (training) #45, 53:57–55:09, prompt injection via Google Doc | 0 | 2 → `important` | "Illustrates a security vulnerability in LLMs, relevant to training/deployment." |
| Git B (branches) #47, 59:22–60:37, `git log` and undoing the last commit | 0 | 10 → `essential` | (unchanged from 1.1) |
| Git C (undo) #43, 54:35–56:07, resolving a merge conflict | 0 | 10 → `essential` | |
| Git A (SSH) #4, 5:08–6:32, list of Git commands | 1 | 7 → `essential` | |

Karpathy C is where the categorical prompt did worst. For the tool-use / LLM OS goal, Nano marked
32 of 50 blocks `important` or `essential`, including the training, jailbreak and prompt-injection
sections. The judge found 7 judge-high blocks.

### Judge-high blocks now rated too low: 3 of 63

| Block | J | Old → new | Reason |
|---|---|---|---|
| Karpathy A (training) #19, 22:21–23:37, labelling instructions for fine-tuning | 7 | 7 → `background` (1.75×) | "Describes labeling process, but not core training." |
| 3Blue1Brown C (weights) #8, 9:10–10:17, deep learning and backpropagation | 7 | 7 → `background` (1.75×) | "Explains model format; helpful context, not core info." |
| Karpathy C (tools / LLM OS) #26, 30:31–31:58, ChatGPT running code to plot data | **9** | 7 → `useful` (1.4×) | "Demonstrates LLM using tools (plotting, code execution) for analysis, relevant." |

These are the first misses in any Goal Mode run. The third one is a clear error: its own reason
says it demonstrates tool use, yet it is only `useful`.

### Category changes substantially with the goal: 58 blocks swing three or more levels

| Block | Training (A) | Security (B) | Tools (C) | Judge A / B / C |
|---|---|---|---|---|
| Karpathy #13, 15:59–16:59, pre-training vs fine-tuning | `essential` | `background` | `background` | 9 / 0 / 0 |
| Karpathy #43, 51:29–52:41, "a different type of attack called the prompt injection attack" | `irrelevant` | `essential` | `useful` | 0 / 9 / 2 |
| Karpathy #25, 29:17–30:31, browsing and citations | `background` | `background` | `essential` | 0 / 0 / 9 |

| Block | Embeddings (A) | Softmax (B) | Weights (C) | Judge A / B / C |
|---|---|---|---|---|
| 3Blue1Brown #14, 15:15–16:27, king + woman − man | `essential` | `background` | `background` | 10 / 0 / 0 |

| Block | Install + SSH (A) | Branches (B) | Undo (C) | Judge A / B / C |
|---|---|---|---|---|
| Git #18, 22:53–24:30, copying the SSH key | `essential` | `background` | `irrelevant` | 10 / 0 / 0 |
| Git #46, 58:17–59:22, `git reset HEAD` | `irrelevant` | `important` | `essential` | 0 / 0 / 10 |
| Git #17, 21:56–22:53, public and private keys | `essential` | **`essential`** | `background` | 10 / 0 / 0 |

The first six show strong, correct conditioning. The last one shows the persistent failure: SSH
keys rated `essential` for the branches goal.

## Correction: POC 1.2 very likely ran the old prompt

**What happened:**
- At the start of this run, the first test call returned a rating **without** `relevanceCategory`,
  although the freshly built `background.js` contained the new parser.
- Chrome had kept serving its cached copy of the extension's previous service worker. The
  extension was reinstalled with `install_extension` from the same path after a browser restart,
  with the same version, and Chrome did not swap in the new worker.
- An explicit `reload_extension` fixed it: the next call returned `relevanceCategory`.
- POC 1.2 was installed the same way, and was "verified" by reading the script file, which shows
  what is on disk, not what is running. So the POC 1.2 runs very likely used the POC 1.1 prompt.
  That would also explain why POC 1.2 differed from POC 1.1 by little more than run-to-run noise.

**This POC 1.3A run is not affected:** every block rating carries a category.

**What was done:**
- POC 1.2 was rerun correctly from commit `74d0fe2`. It was built in a separate worktree and
  installed as an extension at a new path that had never been installed, so there was no cached
  worker. A test call confirmed the numeric prompt was running.
- The results are in `eval-results/goal-mode-poc1.2-rerun/`.
- The original POC 1.2 report and results are left untouched, as asked.

**Result of the corrected POC 1.2 rerun.** The new prompt clearly reached Nano this time: the score
histogram changed from `11 2 80 77 0 39 1 99 7 1 70` to `15 3 61 117 1 0 5 83 4 77 21`.

| Metric | POC 1.1 | POC 1.2 as reported (old prompt, very likely) | POC 1.2 rerun (corrected) | POC 1.3A |
|---|---|---|---|---|
| Precision | 0.36 | 0.36 | 0.34 | 0.35 |
| Recall | 1.00 | 1.00 | 0.98 | 0.95 |
| False-highs (share of high ratings) | 87 (49%) | 85 (49%) | 95 (51%) | 91 (53%) |
| Pearson with judge | 0.73 | 0.73 | 0.68 | 0.68 |
| Share of ratings ≥7 | 45.7% | 45.2% | 47.8% | 44.7% |
| Blocks with a different speed between goals | 80% | 76% | 73% | 57% |
| Slow time on judge ≤3 | 48% | 47% | 50% | 52% |

The corrected rerun moved scores in only two ways: 2 → 3 and 10 → 9. Neither crosses a pacing
threshold. It still rates 48% of blocks ≥7, and precision does not improve. The **POC 1.2
conclusion therefore stands, now on valid data**: the stricter numeric rubric did not fix
over-scoring. The table's 1.2 rerun column is the valid one; the original POC 1.2 report's numbers
should be read as a second POC 1.1 run.

## Recommendation

**C: Categorical relevance does not materially solve the problem; stop prompt and scale tweaking
and investigate a different scoring architecture.**

Why:
- **No calibration gain:**
  - precision 0.36 → 0.35;
  - false-highs 87 → 91;
  - share of blocks rated high 45.7% → 44.7%;
  - correlation with the judge 0.73 → 0.68.
- **New costs:**
  - recall drops for the first time (1.00 → 0.95), including a 9/10 tool-use demo rated `useful`;
  - goal sensitivity weakens (speed changes between goals 80% → 57%);
  - playback spends more of its slow time on judge-low content (48% → 52%);
  - time savings shrink (26.5% → 23.7%).
- **Three prompt formulations, one outcome.** POC 1.1, the corrected POC 1.2 rerun and POC 1.3A
  all land at a precision of 0.34–0.36 with about 45–48% of blocks rated high.
- **The underlying behaviour is the same as with numbers.** Nano sorts blocks into "off the goal"
  and "on the video's subject". Neither a stricter numeric rubric nor named categories made it
  separate "on the subject" from "needed for the goal"; the `important` category is about as noisy
  as the old 7.
- **Not B:** there is no clear improvement to build on.

What is worth keeping for the next design, observed and not tested:
- Nano's rejections are accurate. `background` and `irrelevant` blocks average 0.3 with the judge.
- Its `essential` label carries real signal: 59% judge-high precision, holding 79% of judge-high
  blocks.
- Goal conditioning is strong for individual blocks.
- Latency is excellent.

A different scoring architecture would build on those strengths instead of on one absolute rating
per block, for example by comparing blocks against each other within the same video. That is a new
experiment needing its own approval; nothing beyond this run was implemented.

**Branch state:** the categorical scorer is committed as the current Goal Mode implementation,
because it is the configuration under evaluation. Given these results, keeping it or reverting to
the POC 1.1 numeric scorer is your call.
