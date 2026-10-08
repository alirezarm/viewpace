#!/bin/bash
# Evaluation-only: run every video x goal through the real Goal Mode analysis in the test Chrome
# (eval page of the dist-eval extension copy) and save each run's raw JSON.
set -u
cd "$(dirname "$0")/../.."
EXT="${EVAL_EXT_ID:?set EVAL_EXT_ID}"
OUT=eval-results/goal-mode-poc1/runs
CD() { npx -y -p chrome-devtools-mcp@latest chrome-devtools "$@" 2>&1 | grep -vE "ExperimentalWarning|trace-warnings|exposes content|debug, and modify|Avoid sharing"; }
PAGE=$(CD list_pages | grep -E "$EXT/eval.html" | head -1 | cut -d: -f1)
node -e "for (const v of require('./eval/goal-mode/goals.json')) for (const [g, text] of Object.entries(v.goals)) console.log([v.video, g, JSON.stringify(text), JSON.stringify(v.title)].join('\t'))" |
while IFS=$'\t' read -r VID G GOAL TITLE; do
  KEY="$VID-$G"
  [ -s "$OUT/$KEY.json" ] && { echo "skip $KEY (done)"; continue; }
  echo "$(date +%H:%M:%S) start $KEY"
  CD evaluate_script "async () => { const cap = await (await fetch('transcripts/$VID.capture.json')).json(); return startGoalEval('$KEY', cap, $GOAL, $TITLE); }" --pageId "$PAGE" >/dev/null
  while :; do
    S=$(CD evaluate_script "() => goalEvalStatus('$KEY')" --pageId "$PAGE" | tail -2 | head -1 | tr -d '"')
    [ "$S" != "running" ] && break
    sleep 15
  done
  CD evaluate_script "() => goalEvalResult('$KEY')" --pageId "$PAGE" --filePath "$PWD/$OUT/$KEY.json" >/dev/null
  echo "$(date +%H:%M:%S) $KEY -> $S ($(wc -c < "$OUT/$KEY.json") bytes)"
done
echo "all runs finished"
