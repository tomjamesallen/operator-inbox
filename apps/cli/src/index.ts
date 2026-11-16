import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import { ConfigProvider, Console, Effect, Layer } from 'effect';
import { CliError, Command } from 'effect/cli';
import { inboxSubcommands } from './commands/inbox';
import { infoCommand } from './commands/info';
import { installCommand } from './commands/install';
import { installClaudeHooksCommand } from './commands/install-claude-hooks';
import { serveCommand } from './commands/serve';
import { skillCommand } from './commands/skill';
import { machineTunnelCommand } from './commands/tunnel';
import { processEnvProvider } from './env-config';
import { describeError } from './error-message';
import { InboxLogLazy } from './inbox-store';
import { hideNodeSqliteWarning } from './node-warnings';
import { NodeServicesSparingExitedGroups } from './process-edge';
import { QuestionClassifierClaude } from './question-classifier';
import { exitCodeOf, flushingTeardown } from './runtime-teardown';
import { VERSION } from './version';

// Before anything can load `node:sqlite`: hide its experimental warning, and
// only that one (`node-warnings.ts` says why and when to remove it).
hideNodeSqliteWarning(process);

// Root command + subcommand wiring: the inbox's own subcommands at the top
// level, then serve, the tunnel and the setup commands.
const mainCommand = Command.make('operator-inbox', {}).pipe(
  Command.withDescription(
    'A question inbox an agent session shares with its operator, who answers in the local app',
  ),
  Command.withSubcommands([
    ...inboxSubcommands,
    serveCommand,
    machineTunnelCommand,
    installCommand,
    installClaudeHooksCommand,
    infoCommand,
    skillCommand,
  ]),
);

// Effect 4's runner reads the arguments from the `Stdio` service (NodeServices
// supplies `process.argv.slice(2)`) and names the program after the root
// command, so it takes only the version.
const cli = Command.run(mainCommand, { version: VERSION });

// Render any expected error as one clean `operator-inbox: …` line and exit non-zero —
// no stack trace. The line itself is built in `error-message.ts`.
// The failure carries the error's exit code (`exitCodeOf`) when it is not 1,
// so `flushingTeardown` can exit with it.
const report = (message: string, exitCode = 1) =>
  Console.error(`operator-inbox: ${message}`).pipe(
    Effect.andThen(
      Effect.fail(exitCode === 1 ? message : { message, exitCode }),
    ),
  );

// Help shown because no subcommand was given (bare `operator-inbox`, a bare
// group like `operator-inbox hook`): `Command.run` prints the help, then fails with a
// `ShowHelp` carrying NO parse errors. That is not a failure — Effect 4 itself
// marks it so (`ShowHelp`'s `errorExitCode` is `errors.length ? 1 : 0`). The help is already printed, so the boundary ends
// the run successfully. A `ShowHelp` WITH errors is a parse error: exit 1.
// (`--help`/`-h` never reaches here: it is a global action flag that prints and
// returns.)
const helpWithoutErrors = (e: unknown): e is CliError.ShowHelp =>
  CliError.isCliError(e) && e._tag === 'ShowHelp' && e.errors.length === 0;

// The two CLI errors `Command.run` has ALREADY printed before it rethrows them:
// `ShowHelp` (a parse failure: the help on stdout, then the parse errors on
// stderr) and `UserError`. Reporting either again would print it twice. Any
// other CLI error was not printed by the runner, so it takes the one-line path
// like every domain error.
const printedByRunner = (
  e: unknown,
): e is CliError.ShowHelp | CliError.UserError =>
  CliError.isCliError(e) && (e._tag === 'ShowHelp' || e._tag === 'UserError');

// A single error boundary (chaining several catchers double-prints, since each
// re-catches the previous one's re-failed error). The runner's own printed
// errors pass through; everything else — domain errors and unexpected
// failures — is summarised to one line. The second catcher covers defects.
const main = cli.pipe(
  Effect.catch(
    (
      e,
    ): Effect.Effect<
      void,
      | string
      | { readonly message: string; readonly exitCode: number }
      | CliError.ShowHelp
      | CliError.UserError
    > =>
      helpWithoutErrors(e)
        ? Effect.void
        : printedByRunner(e)
          ? Effect.fail(e)
          : report(describeError(e), exitCodeOf(e)),
  ),
  Effect.catchDefect((d) => report(describeError(d))),
  // Provide NodeServices (with a spawner under which a child that exits 0
  // keeps its process group, `process-edge.ts`), the inbox log
  // and the classifier. Handlers *require* services; every layer is built
  // here, at the runtime edge.
  //
  // The inbox log is LAZY: `InboxLogLazy` opens its SQLite file on the first
  // inbox read, so a command that never reads it (`info`, `skill`) pays
  // nothing, and `serve` starts when the file cannot be opened. It needs
  // NodeServices for config.json and to make the file's folder. The
  // classifier spawns nothing until inbox mode's Stop guard asks it whether
  // a message asks the operator something.
  Effect.provide(
    Layer.mergeAll(
      NodeServicesSparingExitedGroups,
      InboxLogLazy.pipe(Layer.provide(NodeServicesSparingExitedGroups)),
      QuestionClassifierClaude.pipe(
        Layer.provide(NodeServicesSparingExitedGroups),
      ),
    ),
  ),
  // Empty strings kept: `env-config.ts` holds why, and the tests share it.
  Effect.provideService(ConfigProvider.ConfigProvider, processEnvProvider()),
);

// disableErrorReporting: the boundary above already prints a clean line.
// teardown: `flushingTeardown` still exits non-zero on any non-interrupted
// failure, but reports it through `process.exitCode` instead of `process.exit`,
// so a large stdout is not truncated on the way out. See that module's header.
NodeRuntime.runMain(main, {
  disableErrorReporting: true,
  teardown: flushingTeardown,
});
