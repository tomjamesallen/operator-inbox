import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@effect/vitest';
import {
  assetsDirOf,
  CLASSIFIER_PROMPT_FILE,
  chooseWebDist,
  isBundled,
  moduleDir,
  packageRootOf,
  webDistCandidates,
} from '../src/package-paths';
import { classifierPromptPath } from '../src/question-classifier';

// What ships beside the CLI's code is found relative to the CLI package, in
// both shapes it runs in: bundled into `<pkg>/dist/index.js`, and from source
// under `<pkg>/src`.

const PKG = '/opt/operator-inbox/apps/cli';
const BUNDLED = path.join(PKG, 'dist');
const SOURCE = path.join(PKG, 'src');

describe('the CLI package root', () => {
  it('is one level above the module, bundled or from source', () => {
    expect(packageRootOf(BUNDLED)).toBe(PKG);
    expect(packageRootOf(SOURCE)).toBe(PKG);
    expect(isBundled(BUNDLED)).toBe(true);
    expect(isBundled(SOURCE)).toBe(false);
  });

  it('is this package under the test run', () => {
    expect(packageRootOf(moduleDir)).toBe(
      path.resolve(import.meta.dirname, '..'),
    );
  });
});

describe('the assets', () => {
  it('are dist/assets bundled and assets/ from source', () => {
    expect(assetsDirOf(BUNDLED)).toBe(path.join(PKG, 'dist', 'assets'));
    expect(assetsDirOf(SOURCE)).toBe(path.join(PKG, 'assets'));
  });

  it('hold the classifier prompt the classifier reads', () => {
    expect(classifierPromptPath(SOURCE)).toBe(
      path.join(PKG, 'assets', CLASSIFIER_PROMPT_FILE),
    );
    expect(readFileSync(classifierPromptPath(), 'utf8').length).toBeGreaterThan(
      0,
    );
  });
});

describe('the web build', () => {
  const copy = path.join(PKG, 'dist', 'web');
  const sibling = path.join(PKG, '..', 'web', 'dist');

  it('is looked for in the CLI build’s copy, then the web package’s build', () => {
    expect(webDistCandidates(BUNDLED)).toEqual([copy, sibling]);
    expect(webDistCandidates(SOURCE)).toEqual([copy, sibling]);
  });

  it('is the first candidate that holds a build', () => {
    expect(chooseWebDist(SOURCE, () => true)).toBe(copy);
    expect(chooseWebDist(BUNDLED, (d) => d === sibling)).toBe(sibling);
    expect(chooseWebDist(SOURCE, (d) => d === copy)).toBe(copy);
  });

  it('with none built, is where this shape of the CLI would find one', () => {
    expect(chooseWebDist(BUNDLED, () => false)).toBe(copy);
    expect(chooseWebDist(SOURCE, () => false)).toBe(sibling);
  });
});
