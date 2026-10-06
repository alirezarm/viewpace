import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { basename } from 'node:path';

const watch = process.argv.includes('--watch');
// Production builds (for the Web Store) emit no source maps. Code stays unminified so it
// remains readable for store review.
const prod = process.argv.includes('--prod');

/** OS clutter that must never reach dist/ (and therefore the store package). */
const isJunk = (path) => {
  const name = basename(path);
  return name === '.DS_Store' || name.startsWith('._') || name === '__MACOSX';
};

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
cpSync('static', 'dist', { recursive: true, filter: (src) => !isJunk(src) });

const options = {
  entryPoints: {
    hook: 'src/page/hook.ts',
    content: 'src/content/main.ts',
    background: 'src/background/background.ts',
    popup: 'src/popup/popup.ts',
    welcome: 'src/welcome/welcome.ts',
  },
  outdir: 'dist',
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  sourcemap: prod ? false : 'inline',
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('watching… (static/ is copied once; restart after editing it)');
} else {
  await esbuild.build(options);
  console.log(prod ? 'production build: no source maps' : 'development build: inline source maps');
}
