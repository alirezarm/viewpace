// Evaluation-only: build blind judge inputs from transcripts + goals (never from Goal Mode output).
import { readFileSync, writeFileSync } from 'node:fs';
import { transcriptFromTimedtext } from '../../src/content/captions';
import { makeBlocks } from '../../src/content/goal/blocks';

const goals = JSON.parse(readFileSync('eval/goal-mode/goals.json', 'utf8')) as { video: string; title: string; goals: Record<string, string> }[];
for (const v of goals) {
  const cap = JSON.parse(readFileSync(`eval-results/goal-mode-poc1/transcripts/${v.video}.capture.json`, 'utf8'));
  const t = transcriptFromTimedtext(cap.url, cap.body)!;
  const end = Math.max(...t.cues.map((c: { end: number }) => c.end), t.words.at(-1)!.t);
  const blocks = makeBlocks(t.words, end).map((b) => ({ index: b.index, start: Math.round(b.start), end: Math.round(b.end), text: b.text }));
  writeFileSync(`eval-results/goal-mode-poc1/judge/${v.video}.input.json`, JSON.stringify({ video: v.video, title: v.title, goals: v.goals, blocks }, null, 1));
  console.log(v.video, blocks.length, 'blocks');
}
