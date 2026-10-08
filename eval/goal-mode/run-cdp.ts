/**
 * Evaluation-only: same job as run-all.sh, but talks to Chrome's DevTools port directly instead of
 * through the chrome-devtools CLI (whose background daemon reconnected mid-run and closed the eval
 * page). Runs every video x goal on the eval page and saves each run's raw JSON as {status, result}.
 *
 *   npx esbuild eval/goal-mode/run-cdp.ts --bundle --platform=node --format=esm --outfile=/tmp/run-cdp.mjs
 *   EVAL_EXT_ID=<id> EVAL_OUT=eval-results/<folder>/runs [EVAL_PORT=9333] [EVAL_ONLY=<video>] node /tmp/run-cdp.mjs
 *
 * Skips runs already saved, like run-all.sh.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const PORT = process.env.EVAL_PORT ?? '9333';
const EXT = process.env.EVAL_EXT_ID;
const OUT = process.env.EVAL_OUT ?? 'eval-results/goal-mode-poc1/runs';
if (!EXT) throw new Error('set EVAL_EXT_ID');
const PAGE_URL = `chrome-extension://${EXT}/eval.html`;
mkdirSync(OUT, { recursive: true });

interface Target {
  id: string;
  url: string;
  type: string;
  webSocketDebuggerUrl: string;
}

async function evalPage(): Promise<Target> {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as Target[];
  const found = list.find((t) => t.type === 'page' && t.url === PAGE_URL);
  if (found) return found;
  const created = (await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(PAGE_URL)}`, { method: 'PUT' })).json()) as Target;
  await new Promise((r) => setTimeout(r, 1500));
  return created;
}

/** Evaluate an expression on the eval page (awaiting promises) and return its value. */
async function evaluate<T>(expression: string): Promise<T> {
  const t = await evalPage();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      ws.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data));
        if (msg.id !== 1) return;
        if (msg.error || msg.result?.exceptionDetails) reject(new Error(JSON.stringify(msg.error ?? msg.result.exceptionDetails)));
        else resolve(msg.result.result.value as T);
      };
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
  } finally {
    ws.close();
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const time = () => new Date().toTimeString().slice(0, 8);
const videos: { video: string; title: string; goals: Record<string, string> }[] = JSON.parse(readFileSync('eval/goal-mode/goals.json', 'utf8'));

for (const v of videos) {
  if (process.env.EVAL_ONLY && v.video !== process.env.EVAL_ONLY) continue;
  for (const [g, goal] of Object.entries(v.goals)) {
    const key = `${v.video}-${g}`;
    const file = `${OUT}/${key}.json`;
    if (existsSync(file)) {
      console.log(`skip ${key} (done)`);
      continue;
    }
    console.log(`${time()} start ${key}`);
    await evaluate(
      `(async () => { const cap = await (await fetch('transcripts/${v.video}.capture.json')).json(); return startGoalEval(${JSON.stringify(key)}, cap, ${JSON.stringify(goal)}, ${JSON.stringify(v.title)}); })()`,
    );
    let status = 'running';
    while (status === 'running') {
      await sleep(10000);
      status = await evaluate<string>(`goalEvalStatus(${JSON.stringify(key)})`);
    }
    const state = await evaluate<unknown>(`goalEvalResult(${JSON.stringify(key)})`);
    if (status !== 'done') {
      console.log(`${time()} ${key} -> ${status}: ${JSON.stringify(state)}`);
      continue;
    }
    writeFileSync(file, JSON.stringify(state));
    console.log(`${time()} ${key} -> done (${JSON.stringify(state).length} bytes)`);
  }
}
console.log('all runs finished');
