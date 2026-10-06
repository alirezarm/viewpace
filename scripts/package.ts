/**
 * Builds the Chrome Web Store upload: release/viewpace-<version>.zip from a production dist/.
 * Run via `npm run package`, which first runs typecheck, tests and the production build.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { checkReferences, selectFiles, zip, type PackageFile } from './release.ts';

const DIST = 'dist';

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}

const all: PackageFile[] = walk(DIST).map((p) => ({
  path: relative(DIST, p).split(sep).join('/'),
  data: readFileSync(p),
}));
const files = selectFiles(all);
checkReferences(files);

const { version } = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8')) as { version: string };
const out = join('release', `viewpace-${version}.zip`);
const archive = zip(files);
mkdirSync('release', { recursive: true });
writeFileSync(out, archive);

console.log(`Packaged ${files.length} files into ${out} (${(archive.length / 1024).toFixed(1)} KB)`);
for (const f of files) console.log(`  ${f.path}`);
console.log(`sha256 ${createHash('sha256').update(archive).digest('hex')}`);
