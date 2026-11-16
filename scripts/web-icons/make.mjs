#!/usr/bin/env node
// Make the web app's raster icons, under `apps/web/public/icons/`, from two
// SVGs. Run by hand when either changes, then commit the result:
//
//   node scripts/web-icons/make.mjs
//
// - `apps/web/public/icons/favicon.svg`, the tab icon: the full "Oi", its i heavier
//   than the wordmark's so it holds up at 16px. It is shipped as it is; here
//   it is also drawn onto a rounded tile for `favicon-32.png`, the fallback for a browser without SVG favicons. A
//   rasteriser does not apply its dark-scheme rules, so the PNG has the light
//   scheme's colours, and the tile keeps it legible on a dark tab bar.
// - `scripts/web-icons/wordmark.svg`, the full "Oi", for the icons with room
//   for the i: the apple-touch-icon and the manifest's icons. Each is the
//   wordmark on the page's light background: square where the platform rounds
//   the corners itself (iOS, and a maskable icon), rounded where it may not.
//
// `icon-any-512.png` is also the source of the desktop window's icon: run
// `node scripts/desktop-app/make-icon.mjs` after this to rebuild the `.icns`.
//
// sharp is not a dependency of this repo. It is read from the pake install, as
// `scripts/desktop-app/make-icon.mjs` does.

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const icons = join(here, '..', '..', 'apps', 'web', 'public', 'icons');
const favicon = readFileSync(join(icons, 'favicon.svg'));
const wordmark = readFileSync(join(here, 'wordmark.svg'));

const pakeBin = execFileSync('/usr/bin/which', ['pake'], {
  encoding: 'utf8',
}).trim();
const sharp = createRequire(realpathSync(pakeBin))('sharp');

// The light scheme's `--color-bg` (apps/web/src/index.css), which is also the
// manifest's background colour.
const BG = '#fdfcfa';

// The mark scaled to `width` and centred on a `size` square of the background,
// its corners rounded by `radius`.
const tile = async (svg, size, width, radius, density = 600) => {
  const mark = await sharp(svg, { density }).resize({ width }).png().toBuffer();
  const ground = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${radius}" fill="${BG}"/></svg>`,
  );
  return sharp(ground)
    .composite([{ input: mark, gravity: 'centre' }])
    .png();
};

const write = async (image, name) => {
  await image.toFile(join(icons, name));
  process.stdout.write(`wrote ${name}\n`);
};

await write(await tile(favicon, 32, 30, 6, 150), 'favicon-32.png');
// The wordmark across 60% of the square.
await write(await tile(wordmark, 180, 108, 0), 'apple-touch-icon.png');
// The macOS icon's corner, 224 in 1024.
await write(await tile(wordmark, 192, 115, 42), 'icon-192.png');
await write(await tile(wordmark, 512, 307, 112), 'icon-any-512.png');
// Inside the maskable safe zone, the circle of 40% radius at the centre: the
// wordmark's diagonal at 307px wide is 394px, under the zone's 410.
await write(await tile(wordmark, 512, 307, 0), 'icon-maskable-512.png');
