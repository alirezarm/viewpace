/**
 * Pure helpers for the Web Store package: choosing files from dist/, validating them, and
 * writing a deterministic ZIP (sorted entries, fixed timestamps, no OS metadata).
 */
import { crc32, deflateRawSync } from 'node:zlib';

/** OS clutter that is never packaged. */
export function isJunk(path: string): boolean {
  return path.split('/').some((part) => part === '.DS_Store' || part.startsWith('._') || part === '__MACOSX');
}

/** File types an extension package may contain; anything else in dist/ is an error. */
export const ALLOWED_EXTENSIONS = ['.js', '.html', '.css', '.json', '.png', '.svg', '.ico', '.woff2'];

export interface PackageFile {
  path: string; // relative to dist/, forward slashes
  data: Buffer;
}

/**
 * Pick the files to package from everything found in dist/. Junk is dropped; source maps and
 * unexpected file types fail the release instead of being silently skipped.
 */
export function selectFiles(all: PackageFile[]): PackageFile[] {
  const problems: string[] = [];
  const files = all.filter((f) => !isJunk(f.path));
  for (const f of files) {
    if (f.path.endsWith('.map')) problems.push(`source map file: ${f.path}`);
    else if (!ALLOWED_EXTENSIONS.some((ext) => f.path.endsWith(ext))) problems.push(`unexpected file type: ${f.path}`);
    else if (f.path.endsWith('.js') && f.data.includes('sourceMappingURL=')) problems.push(`inline source map in ${f.path}`);
  }
  if (problems.length) throw new Error(`Refusing to package:\n  ${problems.join('\n  ')}`);
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

interface Manifest {
  version?: string;
  background?: { service_worker?: string };
  content_scripts?: { js?: string[]; css?: string[] }[];
  action?: { default_popup?: string; default_icon?: string | Record<string, string> };
  icons?: Record<string, string>;
  options_page?: string;
}

/** Every file the manifest points at must be in the package. */
export function manifestReferences(m: Manifest): string[] {
  const refs = [
    m.background?.service_worker,
    ...(m.content_scripts ?? []).flatMap((c) => [...(c.js ?? []), ...(c.css ?? [])]),
    m.action?.default_popup,
    ...(typeof m.action?.default_icon === 'string' ? [m.action.default_icon] : Object.values(m.action?.default_icon ?? {})),
    ...Object.values(m.icons ?? {}),
    m.options_page,
  ];
  return refs.filter((r): r is string => typeof r === 'string' && r.length > 0);
}

/** Local files referenced by an HTML page (script src, stylesheet href). */
export function htmlReferences(html: string): string[] {
  const refs = [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+)"/g)].map((m) => m[1]!);
  return refs.filter((r) => !/^[a-z]+:/i.test(r) && !r.startsWith('//') && !r.startsWith('#'));
}

/** Throws if a referenced file is missing from the package. */
export function checkReferences(files: PackageFile[]): void {
  const have = new Set(files.map((f) => f.path));
  const manifestFile = files.find((f) => f.path === 'manifest.json');
  if (!manifestFile) throw new Error('manifest.json missing from dist/');
  const missing = new Set<string>();
  for (const r of manifestReferences(JSON.parse(manifestFile.data.toString('utf8')) as Manifest)) if (!have.has(r)) missing.add(r);
  for (const f of files.filter((x) => x.path.endsWith('.html'))) {
    for (const r of htmlReferences(f.data.toString('utf8'))) if (!have.has(r)) missing.add(`${r} (from ${f.path})`);
  }
  if (missing.size) throw new Error(`Missing files referenced by the extension:\n  ${[...missing].join('\n  ')}`);
}

// ---------- deterministic ZIP ----------

const DOS_TIME = 0; // 00:00:00
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
const UNIX_FILE_MODE = 0o100644;

/** A ZIP with entries in the given order, fixed timestamps and no extra fields. */
export function zip(files: PackageFile[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.path, 'utf8');
    const compressed = deflateRawSync(f.data, { level: 9 });
    const crc = crc32(f.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix, spec 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((UNIX_FILE_MODE << 16) >>> 0, 38); // external attrs: rw-r--r--
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + compressed.length;
  }
  const centralDir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDir, end]);
}
