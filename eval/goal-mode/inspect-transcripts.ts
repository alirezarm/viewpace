// Evaluation-only: parse captured caption tracks with ViewPace's production parser and blocker.
import { readFileSync } from 'node:fs';
import { transcriptFromTimedtext } from '../../src/content/captions';
import { makeBlocks } from '../../src/content/goal/blocks';

for (const id of ['zjkBMFhNj_g', 'wjZofJX0v4M', 'RGOj5yH7evk']) {
  const cap = JSON.parse(readFileSync(`eval-results/goal-mode-poc1/transcripts/${id}.capture.json`, 'utf8')) as { url: string; body: string };
  const t = transcriptFromTimedtext(cap.url, cap.body)!;
  const end = Math.max(...t.cues.map((c) => c.end), t.words.at(-1)!.t);
  const blocks = makeBlocks(t.words, end);
  const u = new URL(cap.url);
  console.log(JSON.stringify({ id, lang: t.lang, kind: t.kind || 'uploaded', translated: t.translated, timing: t.timing, words: t.words.length, minutes: +(end / 60).toFixed(1), blocks: blocks.length, avgBlockSec: Math.round(end / blocks.length), tlang: u.searchParams.get('tlang') }));
}
