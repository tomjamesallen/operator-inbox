// @vitest-environment node
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BUILDS_KEPT,
  keepEarlierBuilds,
  keptBuilds,
  staleAssets,
} from '../vite.config';

// The `operator-inbox-keep-earlier-builds` plugin: a page opened before a rebuild
// must still find the chunks its own build names, so `dist/assets` keeps the
// last few builds' files, not only this one's.

describe('keptBuilds', () => {
  it('puts this build first, sorted, and keeps at most BUILDS_KEPT', () => {
    const earlier = Array.from({ length: BUILDS_KEPT + 2 }, (_, i) => [
      `assets/old-${i}.js`,
    ]);
    const builds = keptBuilds(earlier, ['assets/b.js', 'assets/a.js']);
    expect(builds).toHaveLength(BUILDS_KEPT);
    expect(builds[0]).toEqual(['assets/a.js', 'assets/b.js']);
    expect(builds[1]).toEqual(['assets/old-0.js']);
  });

  it('does not count a rebuild with nothing changed twice', () => {
    const builds = keptBuilds(
      [['assets/a.js'], ['assets/z.js']],
      ['assets/a.js'],
    );
    expect(builds).toEqual([['assets/a.js'], ['assets/z.js']]);
  });
});

describe('staleAssets', () => {
  it('names only the files no kept build lists', () => {
    expect(
      staleAssets(
        ['assets/a.js', 'assets/gone.js', 'assets/b.js'],
        [['assets/a.js'], ['assets/b.js']],
      ),
    ).toEqual(['assets/gone.js']);
  });
});

describe('the keep-earlier-builds build step', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  // A `dist` holding `files` under assets/, as a build has just written it.
  const distWith = (files: ReadonlyArray<string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'operator-inbox-web-dist-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'assets'));
    for (const f of files) writeFileSync(join(dir, 'assets', f), '');
    return dir;
  };

  // Runs the plugin's `writeBundle` as Vite would after writing `bundle`.
  const build = (dir: string, files: ReadonlyArray<string>) => {
    for (const f of files) writeFileSync(join(dir, 'assets', f), '');
    const bundle = Object.fromEntries(
      [...files.map((f) => `assets/${f}`), 'index.html'].map((f) => [f, {}]),
    );
    const hook = keepEarlierBuilds().writeBundle;
    if (typeof hook !== 'function') throw new Error('no writeBundle');
    hook.call({} as never, { dir } as never, bundle as never);
  };

  const onDisk = (dir: string) => readdirSync(join(dir, 'assets')).sort();

  it('keeps the earlier build’s chunk, so an old page can still load it', () => {
    const dir = distWith(['index-A.js', 'mermaid.core-A.js']);
    build(dir, ['index-B.js', 'mermaid.core-B.js']);
    expect(onDisk(dir)).toEqual([
      'index-A.js',
      'index-B.js',
      'mermaid.core-A.js',
      'mermaid.core-B.js',
    ]);
    expect(existsSync(join(dir, '.builds.json'))).toBe(true);
  });

  it('deletes the assets of builds older than the last BUILDS_KEPT', () => {
    const dir = distWith(['index-0.js']);
    for (let i = 1; i <= BUILDS_KEPT + 1; i++) build(dir, [`index-${i}.js`]);
    const kept = onDisk(dir);
    expect(kept).toHaveLength(BUILDS_KEPT);
    expect(kept).not.toContain('index-0.js');
    expect(kept).not.toContain('index-1.js');
    expect(kept).toContain(`index-${BUILDS_KEPT + 1}.js`);
    const listed = JSON.parse(
      readFileSync(join(dir, '.builds.json'), 'utf8'),
    ) as string[][];
    expect(listed[0]).toEqual([`assets/index-${BUILDS_KEPT + 1}.js`]);
  });
});
