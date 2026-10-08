# Goal Mode POC 1 evaluation harness (evaluation only)

Not part of the extension build or the release package.

- `eval-page.ts`: bundled into a separate copy of the extension (`dist-eval/`, git-ignored) as
  `eval.html`; runs the production Goal Mode analysis (`GoalSession` + `NanoGoalAnalyzer`, answered
  by the real background service worker) on captured caption tracks and records per-call timing.
- `inspect-transcripts.ts`: parses captured tracks with the production parser/blocker.
- `analyze.ts`: computes goal-sensitivity, distribution, judge-agreement and latency metrics from
  the raw results in `eval-results/goal-mode-poc1/`.

Transcripts were captured with ViewPace's own page hook (the player's caption response); they are
kept under `eval-results/goal-mode-poc1/transcripts/` for reproducibility.

## Re-running

1. `npm run build`, copy `dist/` to `dist-eval/`, bundle `eval-page.ts` into `dist-eval/eval.js`
   (`npx esbuild eval/goal-mode/eval-page.ts --bundle --format=iife --outfile=dist-eval/eval.js`),
   add an `eval.html` that loads it, and copy the captures into `dist-eval/transcripts/`.
2. Load `dist-eval/` unpacked in a manually launched Chrome profile with Gemini Nano available and
   `--remote-debugging-port`, and open `chrome-extension://<id>/eval.html`.
3. `EVAL_EXT_ID=<id> ./eval/goal-mode/run-all.sh` (skips runs already saved).
4. `make-judge-input.ts` writes the blind judge inputs (goals + block text only); judge scores go in
   `judge/<video>.judge.json`.
5. `npx esbuild eval/goal-mode/analyze.ts --bundle --platform=node --format=esm --outfile=/tmp/a.mjs && node /tmp/a.mjs`

Report: `docs/goal-mode-poc1-evaluation.md`.
