#!/usr/bin/env node
// Make the desktop window's icon, `scripts/desktop-app/operator-inbox.icns`,
// from the web app's "Oi" icon (`icon-any-512.png`, made by
// `scripts/web-icons/make.mjs`). Run by hand when that icon changes, then commit
// the result:
//
//   node scripts/desktop-app/make-icon.mjs
//
// It does what Pake does to a `.png` on macOS (a 1024px square with a 224px
// corner radius, shrunk to 840px inside 92px of transparent padding, then an
// iconset made into an `.icns` by `iconutil`), once, so a build bundles the
// committed `.icns` as it is: Pake's own mask step falls back to the unmasked
// image when it fails, and only a warning says so.
//
// sharp is not a dependency of this repo. It is read from the pake install that
// a window build needs anyway, so making the icon adds nothing to install.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = join(
  here,
  '..',
  '..',
  'apps',
  'web',
  'public',
  'icons',
  'icon-any-512.png',
);
const target = join(here, 'operator-inbox.icns');

const pakeBin = execFileSync('/usr/bin/which', ['pake'], {
  encoding: 'utf8',
}).trim();
const sharp = createRequire(realpathSync(pakeBin))('sharp');

const ICONSET = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
];

const clear = { r: 0, g: 0, b: 0, alpha: 0 };
const mask = Buffer.from(
  '<svg width="1024" height="1024"><rect x="0" y="0" width="1024" height="1024" rx="224" ry="224" fill="white"/></svg>',
);

const work = mkdtempSync(join(tmpdir(), 'operator-inbox-icon-'));
try {
  const masked = await sharp(source)
    .ensureAlpha()
    .resize(1024, 1024, { fit: 'contain', background: clear })
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();
  const padded = await sharp(masked)
    .resize(840, 840, { fit: 'contain', background: clear })
    .extend({ top: 92, bottom: 92, left: 92, right: 92, background: clear })
    .png()
    .toBuffer();
  const iconset = join(work, 'operator-inbox.iconset');
  execFileSync('/bin/mkdir', [iconset]);
  for (const [name, size] of ICONSET) {
    await sharp(padded)
      .resize(size, size, { fit: 'contain', background: clear })
      .png()
      .toFile(join(iconset, name));
  }
  execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', target]);
  process.stdout.write(`wrote ${target}\n`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
