// A child for `node-warnings.processes.test.ts`: with `hide`, it installs the
// filter the CLI entry point installs; with anything else, it does not (the
// control that shows the probe can see the warning). Then it loads
// `node:sqlite` and raises two warnings the filter must let through.
import { hideNodeSqliteWarning } from '../../src/node-warnings';

if (process.argv[2] === 'hide') hideNodeSqliteWarning(process);
await import('node:sqlite');
process.emitWarning(
  'Another feature is an experimental feature',
  'ExperimentalWarning',
);
process.emitWarning('SQLite old option is deprecated', 'DeprecationWarning');
