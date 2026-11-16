import path from 'node:path';
import { claudeSettingsPath, planClaudeSettings } from '@operator-inbox/core';
import { Config, Console, Effect, FileSystem, Option, Result } from 'effect';
import { Command } from 'effect/cli';
import type { PlatformError } from 'effect/PlatformError';
import { InputError } from '../errors';

// Merge the inbox's own Claude Code hooks (inbox mode's Stop guard, its
// PreToolUse hook and its UserPromptSubmit hook) into ~/.claude/settings.json.
// The one place the app writes that file, and only when the operator runs
// this on purpose: nothing else calls it.
//
// read → pure plan (`planClaudeSettings`, core) → back up → write atomically.
// The app's entries are recognised by their exact commands
// (`claude-settings.ts`): an older spelling of one of them is replaced by the
// canonical entry, and every other key and every other hook entry, an
// operator's own `operator-inbox` hook included, is left as it was. Idempotent: a
// re-run on its own result writes nothing, not even a backup.
//
// The path is `claudeSettingsPath($HOME)`. `$HOME` is read through `Config`
// and required, so a test (or `HOME=$(mktemp -d)`) points it anywhere and
// nothing falls back to the real home. `$CLAUDE_CONFIG_DIR` is not honoured.
//
// The backup: before EVERY write of an existing file, a byte copy at the first
// free `settings.json.pre-operator-inbox` name (`.pre-operator-inbox.2`, …).
// One per write rather than one ever, because Claude Code and the operator
// edit this file between runs, and a single first-run backup would not hold
// what a later update overwrote; a free name rather than a timestamp, so
// nothing is overwritten and the installer needs no clock. Writes are rare (a
// fresh machine, or a change to the hook commands), so the copies do not pile
// up.

export const BACKUP_SUFFIX = '.pre-operator-inbox';

const HOOK_TIMING_NOTE =
  'Claude Code reads hooks when a session starts: sessions already running keep the hooks they started with.';

const tilde = (home: string, p: string): string =>
  p.startsWith(`${home}${path.sep}`) ? `~${p.slice(home.length)}` : p;

// The file's text, or `null` when there is none.
const readFileOrNull = (
  fs: FileSystem.FileSystem,
  filePath: string,
): Effect.Effect<string | null, PlatformError> =>
  fs.readFileString(filePath).pipe(
    Effect.catchIf(
      (err) => err.reason._tag === 'NotFound',
      () => Effect.succeed(null),
    ),
  );

// The first backup name nothing holds yet.
const freeBackupName = (
  fs: FileSystem.FileSystem,
  target: string,
): Effect.Effect<string, PlatformError> =>
  Effect.gen(function* () {
    const first = `${target}${BACKUP_SUFFIX}`;
    if (!(yield* fs.exists(first))) return first;
    let n = 2;
    while (yield* fs.exists(`${first}.${n}`)) n += 1;
    return `${first}.${n}`;
  });

// Is the path a symlink? `readLink` succeeds on one and fails on anything
// else, a missing path included.
const isSymlink = (fs: FileSystem.FileSystem, target: string) =>
  fs.readLink(target).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );

export const installClaudeHooksEffect = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* Config.option(Config.String('HOME')).pipe(Effect.orDie);
  if (Option.isNone(home) || home.value === '') {
    return yield* new InputError({
      message: 'HOME is not set, so ~/.claude/settings.json cannot be found',
    });
  }
  const settings = claudeSettingsPath(home.value);
  const shown = tilde(home.value, settings);

  const raw = yield* readFileOrNull(fs, settings);
  const planned = planClaudeSettings(raw);
  if (Result.isFailure(planned)) {
    return yield* new InputError({
      message: `${shown}: ${planned.failure}; left unchanged. Fix it by hand, then re-run operator-inbox install-claude-hooks`,
    });
  }
  const plan = planned.success;
  if (!plan.changed) {
    yield* Console.log(`${shown}: operator-inbox hooks already up to date`);
    return;
  }

  // A settings.json that is a symlink (a dotfiles-managed one) is written
  // through to the file it names, so the link survives the rename below.
  // Only a link is resolved: `realPath` on a plain file would also rewrite its
  // parent dirs (macOS `/var` → `/private/var`) and the report with them.
  const target = (yield* isSymlink(fs, settings))
    ? yield* fs.realPath(settings)
    : settings;
  yield* fs.makeDirectory(path.dirname(target), { recursive: true });

  if (raw !== null) {
    const backup = yield* freeBackupName(fs, target);
    yield* fs.copyFile(target, backup);
    yield* Console.log(`${shown}: backed up to ${tilde(home.value, backup)}`);
  }

  // Atomic: write a sibling, carry the old file's permission bits over, then
  // rename it over the target, so Claude Code never reads a half-written file.
  const staging = `${target}.operator-inbox-tmp`;
  yield* fs.writeFileString(staging, plan.next);
  if (raw !== null) {
    const info = yield* fs.stat(target);
    yield* fs.chmod(staging, info.mode & 0o777);
  }
  yield* fs.rename(staging, target);

  for (const { event, run, change } of plan.changes) {
    yield* Console.log(`${shown}: ${event} hook (${run}) ${change}`);
  }
  yield* Console.log(HOOK_TIMING_NOTE);
});

export const installClaudeHooksCommand = Command.make(
  'install-claude-hooks',
  {},
  () => installClaudeHooksEffect,
).pipe(
  Command.withDescription(
    "Merge the inbox's Claude Code hooks (inbox mode's Stop, PreToolUse and UserPromptSubmit hooks) into ~/.claude/settings.json, backing the file up first. Touches no other key or entry; a re-run writes nothing",
  ),
);
