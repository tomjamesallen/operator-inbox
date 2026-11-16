import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Effect, FileSystem } from 'effect';

// Where the CLI finds what ships beside its code: the assets (the classifier's
// prompt, the skill) and the web build. Everything is found relative to the
// CLI package itself, never through a repo-root search, so an installed bin
// and a source checkout both work from wherever they are run.
//
// The package root is one level above this module in both shapes: tsup
// bundles every module into `<pkg>/dist/index.js`, and under `tsx` or vitest
// this file is `<pkg>/src/package-paths.ts`.

/** The directory this module runs from: `<pkg>/dist` bundled, `<pkg>/src` from source. */
export const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/** Is `dir` the bundle's directory (`<pkg>/dist`)? */
export const isBundled = (dir: string): boolean =>
  path.basename(dir) === 'dist';

/** The CLI package root, from the module directory. */
export const packageRootOf = (dir: string): string => path.dirname(dir);

/**
 * The assets directory: `<pkg>/dist/assets` when bundled (the build copies
 * `assets/` there), `<pkg>/assets` from source.
 */
export const assetsDirOf = (dir: string): string =>
  isBundled(dir)
    ? path.join(dir, 'assets')
    : path.join(packageRootOf(dir), 'assets');

/** The classifier's system prompt, an asset. */
export const CLASSIFIER_PROMPT_FILE = 'classify-question.md';

/** The agent skill `operator-inbox skill` prints, an asset. */
export const SKILL_FILE = 'SKILL.md';

/**
 * Where a web build may be, in the order they are tried: the copy the CLI
 * build makes (`<pkg>/dist/web`), then the web package's own build beside the
 * CLI package (`<pkg>/../web/dist`), which is what a run from source has.
 */
export const webDistCandidates = (dir: string): ReadonlyArray<string> => {
  const root = packageRootOf(dir);
  return [path.join(root, 'dist', 'web'), path.join(root, '..', 'web', 'dist')];
};

/**
 * The web build to serve: the first candidate holding an `index.html`. With
 * none built yet, the one this shape of the CLI would use (the copy when
 * bundled, the web package's build from source), so a build made while serve
 * runs is picked up without a restart. Pure over `hasIndex`.
 */
export const chooseWebDist = (
  dir: string,
  hasIndex: (candidate: string) => boolean,
): string => {
  const [copy, sibling] = webDistCandidates(dir) as readonly [string, string];
  if (hasIndex(copy)) return copy;
  if (hasIndex(sibling)) return sibling;
  return isBundled(dir) ? copy : sibling;
};

/** `chooseWebDist` over the filesystem, from this module's own location. */
export const locateWebDist = (dir: string = moduleDir) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const found = new Set<string>();
    for (const candidate of webDistCandidates(dir)) {
      const exists = yield* fs
        .exists(path.join(candidate, 'index.html'))
        .pipe(Effect.orElseSucceed(() => false));
      if (exists) found.add(candidate);
    }
    return chooseWebDist(dir, (candidate) => found.has(candidate));
  });

/** The command that makes the web build, named where it is reported missing. */
export const WEB_BUILD_COMMAND =
  'pnpm build (in the operator-inbox checkout: it builds the web app and copies it into the CLI)';
