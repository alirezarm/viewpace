import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { checkReferences, htmlReferences, isJunk, manifestReferences, selectFiles, zip, type PackageFile } from '../scripts/release.ts';

const file = (path: string, text = 'x'): PackageFile => ({ path, data: Buffer.from(text) });

describe('choosing files for the store package', () => {
  it('drops OS clutter', () => {
    for (const p of ['.DS_Store', 'img/.DS_Store', '._popup.js', '__MACOSX/popup.js']) expect(isJunk(p)).toBe(true);
    expect(isJunk('popup.js')).toBe(false);
  });

  it('keeps extension files, sorted, without junk', () => {
    const picked = selectFiles([file('popup.js'), file('.DS_Store'), file('background.js'), file('._x.js'), file('a/b.css')]);
    expect(picked.map((f) => f.path)).toEqual(['a/b.css', 'background.js', 'popup.js']);
  });

  it('refuses source maps, inline source maps and unexpected files', () => {
    expect(() => selectFiles([file('content.js.map')])).toThrow(/source map file/);
    expect(() => selectFiles([file('content.js', 'x\n//# sourceMappingURL=data:application/json;base64,e30=')])).toThrow(/inline source map/);
    expect(() => selectFiles([file('main.ts')])).toThrow(/unexpected file type/);
    expect(() => selectFiles([file('README.md')])).toThrow(/unexpected file type/);
  });
});

describe('reference checks', () => {
  const manifest = JSON.parse(readFileSync('static/manifest.json', 'utf8'));

  it('finds every file the real manifest needs', () => {
    expect(manifestReferences(manifest).sort()).toEqual(['background.js', 'content.js', 'hook.js', 'popup.html']);
  });

  it('finds local scripts and stylesheets in the real pages, ignoring external links', () => {
    expect(htmlReferences(readFileSync('static/popup.html', 'utf8')).sort()).toEqual(['popup.js', 'ui.css']);
    expect(htmlReferences('<link rel="stylesheet" href="https://fonts.example/x.css"><script src="a.js"></script>')).toEqual(['a.js']);
  });

  it('fails when a referenced file is missing', () => {
    const m = file('manifest.json', JSON.stringify({ background: { service_worker: 'background.js' }, action: { default_popup: 'popup.html' } }));
    const popup = file('popup.html', '<script src="popup.js"></script>');
    expect(() => checkReferences([m, popup, file('background.js')])).toThrow(/popup\.js \(from popup\.html\)/);
    expect(() => checkReferences([m, popup, file('background.js'), file('popup.js')])).not.toThrow();
  });
});

/** Minimal reader for our own archives: walks local headers and inflates each entry. */
function unzip(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let p = 0;
  while (buf.readUInt32LE(p) === 0x04034b50) {
    const compSize = buf.readUInt32LE(p + 18);
    const nameLen = buf.readUInt16LE(p + 26);
    const name = buf.subarray(p + 30, p + 30 + nameLen).toString('utf8');
    const start = p + 30 + nameLen;
    out[name] = inflateRawSync(buf.subarray(start, start + compSize)).toString('utf8');
    p = start + compSize;
  }
  return out;
}

describe('deterministic zip', () => {
  const files = [file('manifest.json', '{"version":"1"}'), file('popup.js', 'console.log(1)'.repeat(50))];

  it('round-trips file contents', () => {
    expect(unzip(zip(files))).toEqual({ 'manifest.json': '{"version":"1"}', 'popup.js': 'console.log(1)'.repeat(50) });
  });

  it('produces identical bytes for identical input', () => {
    expect(zip(files).equals(zip(files))).toBe(true);
  });

  it('ends with a valid end-of-central-directory record', () => {
    const z = zip(files);
    expect(z.readUInt32LE(z.length - 22)).toBe(0x06054b50);
    expect(z.readUInt16LE(z.length - 22 + 10)).toBe(2);
  });
});
