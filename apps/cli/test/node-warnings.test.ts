import { describe, expect, it } from '@effect/vitest';
import { isNodeSqliteWarning } from '../src/node-warnings';

// Hide node:sqlite's ExperimentalWarning and no other warning. The predicate
// is pinned here; both halves are shown in real child processes in
// `node-warnings.processes.test.ts`.

describe('isNodeSqliteWarning', () => {
  it('matches node:sqlite’s experimental warning in each form emitWarning takes', () => {
    const text =
      'SQLite is an experimental feature and might change at any time';
    expect(isNodeSqliteWarning(text, ['ExperimentalWarning'])).toBe(true);
    expect(isNodeSqliteWarning(text, [{ type: 'ExperimentalWarning' }])).toBe(
      true,
    );
    const error = new Error(text);
    error.name = 'ExperimentalWarning';
    expect(isNodeSqliteWarning(error, [])).toBe(true);
  });

  it('lets every other warning through', () => {
    expect(
      isNodeSqliteWarning('VM Modules is an experimental feature', [
        'ExperimentalWarning',
      ]),
    ).toBe(false);
    expect(
      isNodeSqliteWarning('SQLite old option is deprecated', [
        'DeprecationWarning',
      ]),
    ).toBe(false);
    expect(isNodeSqliteWarning('SQLite is an experimental feature', [])).toBe(
      false,
    );
  });
});
