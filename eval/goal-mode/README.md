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

### Gotchas (learned the hard way)

- **Stale service worker:** after a browser restart, `install_extension` of the same unpacked path
  (same version) can keep running Chrome's cached copy of the *previous* background worker. Reading
  `background.js` from disk proves nothing. Always `reload_extension` after installing, or install
  from a never-used path, and verify behaviourally (e.g. a test call whose output only the new code
  produces). This silently invalidated the first POC 1.2 run; see docs/goal-mode-poc1.3a-evaluation.md.
- **CLI reconnects:** the chrome-devtools CLI daemon occasionally reconnects mid-run and closes the
  pages it opened. `run-cdp.ts` talks to the DevTools port directly and is the preferred runner:
  `npx esbuild eval/goal-mode/run-cdp.ts --bundle --platform=node --format=esm --outfile=/tmp/run-cdp.mjs && EVAL_EXT_ID=<id> EVAL_OUT=<dir>/runs node /tmp/run-cdp.mjs`
- Comparing a variant with the POC 1.1 baseline: run `analyze.ts` with `EVAL_RUNS`/`EVAL_METRICS_OUT`
  for the variant, then `EVAL_NEW=<variant folder> compare.ts`.
- POC 1.4 (rolling context): runs also save each block's `contextIn`/`rollingContext`.
  `context-metrics.ts` reports the notes' size, growth and repetition plus per-block cost against
  POC 1.1; with `EVAL_EXT_ID` set (eval page open) it counts tokens with Nano's own tokenizer:
  `npx esbuild eval/goal-mode/context-metrics.ts --bundle --platform=node --format=esm --outfile=/tmp/cm.mjs && EVAL_NEW=eval-results/goal-mode-poc1.4 EVAL_EXT_ID=<id> node /tmp/cm.mjs`
- POC 1.5 (fixed goal breakdown): runs save the breakdown as `needs` and its call as a `breakdown`
  call. `breakdown-metrics.ts` lists each run's breakdown and compares cost with POC 1.1 and 1.4.
  To compare against a variant other than POC 1.1, set `EVAL_BASE` for `compare.ts`
  (e.g. `EVAL_BASE=eval-results/goal-mode-poc1.4`); it writes `compare-vs-poc1.4.*`.
- Historical prompts: production now holds only the final Goal Mode prompts. `context-metrics.ts`
  reads the POC 1.4 block prompt from its evaluated commit (`8adf93f`) via `git show`, and
  `breakdown-metrics.ts`/`context-metrics.ts` read POC 1.1's from `1b69f3a`.
