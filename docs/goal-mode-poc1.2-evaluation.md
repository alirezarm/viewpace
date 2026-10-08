# Goal Mode POC 1.2: stricter relevance rubric, evaluated against POC 1.1

POC 1.1 is the baseline, documented in [goal-mode-poc1-evaluation.md](goal-mode-poc1-evaluation.md)
(commit `1b69f3a`). This experiment is the same Gemini Nano, the same blocks and the same goals,
with only a **stricter relevance definition** in the block prompt.

## Summary

**The stricter rubric had no meaningful effect.** Nano's relevance scores are practically unchanged:

- high-relevance (≥7) precision is 0.36 → 0.36;
- false-highs (Goal Mode ≥7, judge ≤3) are 87 → 85;
- 45.7% → 45.2% of ratings are ≥7;
- correlation with the judge is unchanged (0.73 → 0.73).

Measured as the mean absolute change in a block's score, the prompt change moves scores by
0.22–0.35 points. Simply repeating a run with the *same* prompt moves them by 0.13 points. So the
whole effect is barely above run-to-run noise.

Nothing was lost:
- recall stays 100%, and there are no new misses of judge-high blocks;
- goal sensitivity, latency and failure rates are about the same.

The problem the rubric targeted, "on the video's subject" scored as "important for the goal", is
untouched. Many reasons still say "indirectly relevant" or "but lacks …" next to a score of 7.

**Recommendation: C.** Prompt calibration alone did not solve the relevance problem. The details
are at the end.

## The change

Only the `relevance` bullet of `BLOCK_SYSTEM_PROMPT` in `src/shared/goal-prompt.ts` changed. The
attention rubric, schema, field order, parsing, blocks, sections, speed table, controller and UI
are unchanged.

```diff
-- relevance (0-10): how much it helps the viewer's goal. 0 = unrelated (intro, sponsor, small talk, off-topic); 5 = useful background; 10 = directly answers the goal.
+- relevance (0-10): how much it helps the viewer achieve their stated goal.
+  Topical similarity is NOT goal relevance. Ask: "If the viewer skipped this excerpt, would they lose information they need for their goal?" If not, relevance should normally be 0-4.
+  0-2 = does not help the goal (it may still discuss the video's general subject; intros, sponsors, small talk)
+  3-4 = background or context, only indirectly useful
+  5-6 = directly useful for the goal
+  7-8 = important information for the goal
+  9-10 = essential: skipping it would clearly hurt the viewer's ability to achieve the goal
+  Do not give 7 or more just because the excerpt is about the same broad subject as the goal.
```

The wording was approved before implementation. It was evaluated **once**, with no further edits
and no tuning against the judge.

## Method

The setup is exactly as in POC 1.1:
- **Same material:** the same 3 videos, saved transcripts, 129 blocks (same production
  `makeBlocks`) and 9 goals.
- **Same judge scores:** the saved blind Claude judge scores. Nothing was relabelled.
- **Same harness:** `eval/goal-mode/eval-page.ts` calls the production `GoalSession` and
  `NanoGoalAnalyzer`, answered by the production service worker.
- **Same machine:** M1 Pro, Chrome 154, Gemini Nano, Normal pace, start at 0:00.

The only difference is the rebuilt service worker. Its running script was checked to contain the
new rubric and not the old one.

**Noise baseline (added):** the 3Blue1Brown video's three goals were run a second time with the
POC 1.2 prompt (`eval-results/goal-mode-poc1.2/repeat-runs/`). This gives a reference for how much
scores move with no prompt change at all.

| Comparison, 3Blue1Brown, 72 ratings | mean abs score change | identical scores | ≥7 flips |
|---|---|---|---|
| POC 1.2 vs POC 1.2 repeat (noise only) | 0.13 | 93.1% | 1 |
| POC 1.1 vs POC 1.2 | 0.22 | 87.5% | 3 |
| POC 1.1 vs POC 1.2 repeat | 0.35 | 80.6% | 4 |

Across all 387 ratings, the mean score change from the old to the new prompt is **0.00**:
- 169 of 177 old ≥7 ratings stay ≥7;
- 8 drop below 7 (7 of them to 5–6, 1 to ≤4);
- 6 others rise to ≥7.

Files:
- `eval-results/goal-mode-poc1.2/runs/`: raw POC 1.2 runs.
- `eval-results/goal-mode-poc1.2/metrics.{json,md}`: the full per-video tables, same format as 1.1.
- `eval-results/goal-mode-poc1.2/compare.{json,md}`: the before/after comparison and every
  example in each regression category.
- Scripts: `eval/goal-mode/analyze.ts` (now takes `EVAL_RUNS` and `EVAL_METRICS_OUT`) and
  `eval/goal-mode/compare.ts`.

## Before / after

The judge is a Claude agent and an approximate reference, not ground truth. "High" means ≥7.

| Metric | POC 1.1 | POC 1.2 |
|---|---|---|
| **Precision** (GM-high also judge-high) | **0.36** (63/177) | **0.36** (63/175) |
| **Recall** (judge-high also GM-high) | **1.00** (63/63) | **1.00** (63/63) |
| **False-high** (GM ≥7, judge ≤3) | **87**: 49.2% of GM-high, 22.5% of all ratings | **85**: 48.6% of GM-high, 22.0% of all ratings |
| False-low (GM ≤3, judge ≥7) | 0 | 0 |
| Pearson / Spearman with judge | 0.73 / 0.71 | 0.73 / 0.71 |
| MAE / mean signed error (GM − judge) | 3.26 / +3.18 | 3.27 / +3.18 |
| Relevance mean / median / sd | 5.30 / 5 / 3.02 | 5.30 / 5 / 3.02 |
| Ratings ≥7 / ≥8 | 45.7% / 20.2% | 45.2% / 20.7% |
| Histogram 0…10 | `11 2 80 77 0 39 1 99 7 1 70` | `11 1 82 76 0 42 0 95 8 1 71` |
| Runs flagged high-bunched | 3 of 9 | 3 of 9 (the same three) |
| Blocks ≥7 for 2+ goals of a video (of 129) | 54 | 54 |
| Attention mean (rubric unchanged) | 5.41 | 5.37 |

For reference, the judge's histogram is `218 42 17 17 12 9 9 9 15 26 13` (16.3% ≥7).

**Goal sensitivity (means over the 9 goal pairs):**

| Metric | POC 1.1 | POC 1.2 |
|---|---|---|
| Mean abs relevance difference between goals | 3.72 | 3.65 |
| Blocks with ΔR ≥2 / ≥3 | 78.2% / 64.0% | 76.5% / 61.4% |
| Top-20% Jaccard (ties incl.), mean | 0.05 (0.16) | 0.05 (0.10) |
| Top-20% Jaccard (ties incl.), max | 0.31 | 0.22 |
| Blocks with a different target speed | 79.9% | 76.5% |
| Mean abs target-speed difference | 0.47× | 0.46× |

**Playback (Normal pace, 465.5 min of video):**

| Metric | POC 1.1 | POC 1.2 |
|---|---|---|
| Watch time with Goal Mode | 342.3 min (−26.5%) | 341.6 min (−26.6%) |
| Watch time with judge-based pacing (reference) | 276.0 min (−40.7%) | 275.8 min |
| Slow playback (≤1.15×) | 198.9 min | 195.0 min |
| …of which on judge ≤3 content | **48.0%** | **47.2%** |
| Judge-high content played at ≥1.75× | 0 min | 0 min |

**Latency and failures:**

| Metric | POC 1.1 | POC 1.2 |
|---|---|---|
| Start → first useful decision, mean (max) | 2.98 s (3.72) | 2.93 s (3.68) |
| Start → first 5 minutes mapped, mean | 12.6 s | 12.3 s |
| Block call median | 2.57 s | 2.58 s |
| Mapping speed, mean | 26.3× real time | 25.0× real time |
| Retries / failed blocks | 0 / 0 | 2 / 0 |
| Valid section groupings | 11 / 15 | 7 / 15 |

Notes:
- **Retries:** both were a single call timing out ("signal is aborted"), then succeeding on retry.
  Two 1.2 runs took about 179 s instead of about 150 s to map completely; time to the first
  decision was unaffected.
- **Section groupings:** the section prompt didn't change, but its input is the per-block topic
  strings, which differ slightly between runs. Groupings are display only; the drop most likely
  reflects how fragile pass-2 validation is, not the relevance rubric.

**Per run** (number of blocks the judge rated ≥7, then GM ≥7 / precision / false-high):

| Run | judge ≥7 | POC 1.1 | POC 1.2 |
|---|---|---|---|
| Karpathy A: training | 12 | 30 / 0.40 / 14 | 31 / 0.39 / 15 |
| Karpathy B: security | 11 | 13 / 0.85 / 1 | 13 / 0.85 / 1 |
| Karpathy C: tools / LLM OS | 7 | 21 / 0.33 / 11 | 24 / 0.29 / 14 |
| 3Blue1Brown A: embeddings | 4 | 10 / 0.40 / 2 | 9 / 0.44 / 1 |
| 3Blue1Brown B: softmax | 3 | 7 / 0.43 / 3 | 8 / 0.38 / 4 |
| 3Blue1Brown C: weights | 4 | 17 / 0.24 / 9 | 16 / 0.25 / 8 |
| Git A: install + SSH | 5 | 25 / 0.20 / 20 | 22 / 0.23 / 17 |
| Git B: branches | 13 | 38 / 0.34 / 16 | 37 / 0.35 / 15 |
| Git C: undo / reset | 4 | 16 / 0.25 / 11 | 15 / 0.27 / 10 |

Recall is 1.00 in every run, before and after.

## Examples

All examples in each category are listed in `eval-results/goal-mode-poc1.2/compare.md`. "J" is the
judge's score.

### False-highs fixed by the new rubric: 8 of 87

These are typical Git basics and video-introduction blocks that moved from 7 to 5 (1.15× → 1.4×).
Only one block moved below 5.

| Block | J | Old → new | New reason |
|---|---|---|---|
| Git A (SSH) #1, 1:27–2:40, "what is version control?…" | 1 | R7 → R5 | "Explains Git's purpose; foundational knowledge." |
| Git C (undo) #26, 33:37–34:47, how a feature branch diverges from master | 0 | R7 → R5 | "Explains branch behavior, foundational to undoing changes." |
| Git B (branches) #15, 18:52–20:33, `git add .` and `git status` | 0 | R7 → R5 | "…a step before pushing. Helpful but not core" |
| 3Blue1Brown A (embeddings) #21, 23:30–25:06, softmax and sampling | 0 | R7 → R3 | "Discusses sampling techniques in LLMs, indirectly related to meaning in space" |
| 3Blue1Brown C (weights) #0, 0:00–1:13, "GPT stands for Generative Pretrained Transformer…" | 1 | R7 → R5 | "Introduces transformers, core to LLMs, but lacks technical details." |

The reason for 3Blue1Brown C #0 is word for word the same as before; only the number changed.

### False-highs that remain: 85, including 6 new ones

The same pattern as POC 1.1. Reasons that hedge, or that link the block to the goal only through
the shared subject, still come with 7–10. 25 of the 85 remaining reasons contain an explicit hedge
("indirectly", "but lacks", "foundational", "context").

| Block | J | Old → new | New reason |
|---|---|---|---|
| Karpathy A (training) #27, 31:58–33:08, "the tool use aspect of these language models" | 0 | 7 → 7 | "Demonstrates LLM's ability to use external tools, relevant to training evolution" |
| Karpathy A (training) #36, 43:27–44:22, LLM OS diagram, context window | 0 | 7 → 7 | "Explains a key concept (context window) in LLM operation." |
| Karpathy C (tools / LLM OS) #12, 14:31–15:59, how assistant models are made | 0 | 7 → 7 | "Explains how assistant models are created, a core component of LLM tool use." |
| Karpathy C (tools / LLM OS) #38, 45:43–46:57, jailbreak example | 1 | 7 → **10** | "Directly illustrates LLM security challenges; relevant to goal." |
| 3Blue1Brown B (softmax) #4, 4:29–5:53, MLP / feed-forward layer | 3 | 10 → 10 | "Directly describes the softmax operation's purpose." |
| 3Blue1Brown B (softmax) #8, 9:10–10:17, deep learning and backpropagation | 2 | 7 → 7 | "Mentions probability distribution in final layer, but lacks softmax/temperature." |
| 3Blue1Brown B (softmax) #19, 21:40–22:31 (new false-high) | 3 | 5 → 7 | "Mentions softmax function's future role; indirectly relevant." |
| Git B (branches) #13, 16:32–17:34 (new false-high) | 0 | 5 → 7 | "Explains where Git stores changes, relevant to understanding branches/merges." |

Karpathy C #38 and 3Blue1Brown B #8 and #19 directly contradict the new instructions:
- Karpathy C #38 is a security block scored 10 for the tool-use goal, the exact
  "same broad subject" case the rubric names.
- 3Blue1Brown B #8 and #19 are scored 7 while their own reasons say "lacks" and
  "indirectly relevant".

### Blocks that were correctly high but became too low: none

None of the 63 blocks rated ≥7 by both Goal Mode 1.1 and the judge dropped below 7.

### Judge-high blocks the new prompt misses: none

All 63 judge-high blocks are still ≥7, so recall is 1.00. There are no false-lows.

Precision did **not** go up by lowering everything, and it did not go up at all. The scores barely moved.

## Interpretation

What the data shows:

- **The scores barely moved.** Nano produces almost the same scores, mostly from the same five
  values (2, 3, 5, 7, 10), whichever rubric text it gets. The difference from the old prompt is
  only slightly larger than the difference between two identical runs.
- **The rubric does reach the reasons, but not the numbers.** Some reasons now say "foundational"
  or "not core". But a reason saying "indirectly relevant" or "but lacks …" still often comes with
  7. So Nano can tell a block is only *related*; it just doesn't turn that into a lower number.
- **The score is generated before the reason.** The schema emits `relevance` before `reason`, so the
  number is fixed before any explanation is written. This was noted as out of scope and was not
  tested; it is a plausible contributor.
- **Goal conditioning and latency are intact.** The new prompt added about 120 tokens per call and
  cost roughly 1–2% in mapping throughput.

## Recommendation

**C: Prompt calibration alone did not solve the relevance problem; investigate another approach.**

Why:
- The specific hypothesis was "a stricter, counterfactual relevance definition makes Nano stop
  scoring on-topic content as important". It was tested cleanly (same Nano, blocks, goals and
  judge, one approved change) and the answer is no:
  - precision 0.36 → 0.36;
  - false-highs 87 → 85;
  - high-end share 45.7% → 45.2%;
  - slow time spent on judge-low content 48% → 47%.

  All of these are at the level of run-to-run noise.
- This is not B. Calibration did not improve substantially, so there is no single remaining issue
  to polish.
- It is not A. The original problem persists in full: about half of Goal Mode's "important"
  blocks are judged essentially irrelevant, and nearly half of the slowed-down playback is spent
  on them.
- The good properties from POC 1.1 are still there and remain worth building on: strong goal
  sensitivity, 100% recall, about 3 s to the first decision, and no failed blocks.

Possible directions to investigate. None of these was tried here; each would be its own approved
experiment, measured on this same dataset and judge:
1. Have Nano write a short "does this excerpt answer the goal?" judgement before the number, by
   putting the reason first in the schema or by adding an explicit yes/partly/no field.
2. Have Nano compare blocks against each other, or rate several blocks in one prompt, instead of
   giving one block an absolute score in isolation.
3. Replace the 0–10 scale with a few discrete labels, since Nano effectively uses only five values
   anyway.
4. Score the goal-relevant information each block contains, instead of the subject it shares with
   the goal.

**Current branch state:** the POC 1.2 rubric is committed in `src/shared/goal-prompt.ts` because
it is the evaluated configuration. It doesn't hurt anything measured, but it doesn't help either,
and it adds about 120 tokens per call. Keeping it or reverting it to the 1.1 wording is your call.
