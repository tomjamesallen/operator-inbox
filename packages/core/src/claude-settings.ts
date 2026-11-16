import path from 'node:path';
import { Result, Schema } from 'effect';
import { PRE_TOOL_NAMES } from './inbox-mode';

// The app's own hook entries in Claude Code's user settings
// (`~/.claude/settings.json`), and the pure merge that puts them there. The
// ONE writer is `operator-inbox install-claude-hooks`, which the operator runs
// on purpose: nothing else writes the file.
//
// Pure: the edge reads the file and hands the raw text (or `null` when it is
// absent) in, and writes `next` back only when `changed`. No clock, no fs, no
// environment.

/** Claude Code's user settings file, under the operator's home. */
export const claudeSettingsPath = (homedir: string): string =>
  path.join(homedir, '.claude', 'settings.json');

// The hook events the app registers under, in the order they are added to a
// settings file that has none of them.
export type ClaudeHookEvent = 'Stop' | 'PreToolUse' | 'UserPromptSubmit';

// One of the app's hooks: the event, the optional tool matcher, what it runs,
// and the one command handler the matcher group holds, which wraps `run`.
export interface ClaudeHook {
  readonly event: ClaudeHookEvent;
  readonly matcher?: string;
  // The app's command itself.
  readonly run: string;
  readonly command: string;
  readonly timeout: number;
  // How the merge recognises THIS hook's handler: its command, trimmed, is
  // exactly one of these, the canonical `command` or the bare `run` an older
  // or hand-written entry holds. A handler that matches none is foreign and is
  // never changed, even one that runs another `operator-inbox` subcommand of
  // the operator's own (`operator-inbox watch …`).
  readonly spellings: ReadonlyArray<string>;
}

// The binary every inbox-mode hook runs.
export const HOOK_MARKER = 'operator-inbox';

// `command -v` first, so a machine without operator-inbox on PATH runs no hook
// and the turn is never blocked by a missing binary; `|| true`, so a command
// that fails never blocks it either (each subcommand fails open by design, and
// this is the belt to that braces).
const hookOf = (
  event: ClaudeHookEvent,
  subcommand: string,
  timeout: number,
  matcher?: string,
): ClaudeHook => {
  const run = `${HOOK_MARKER} ${subcommand}`;
  const command = `command -v ${HOOK_MARKER} >/dev/null 2>&1 && ${run} || true`;
  return {
    event,
    ...(matcher === undefined ? {} : { matcher }),
    run,
    command,
    timeout,
    spellings: [command, run],
  };
};

// The canonical entries: the three inbox-mode hooks. The Stop timeout is 30 s,
// sized for the Haiku classifier the guard runs inside it (a 20 s budget); the
// other two only read local state. The PreToolUse matcher is the pre-tool
// hook's own tool list (`inbox-mode.ts`).
export const CLAUDE_HOOKS: ReadonlyArray<ClaudeHook> = [
  hookOf('Stop', 'guard', 30),
  hookOf('PreToolUse', 'hook pre-tool', 10, PRE_TOOL_NAMES.join('|')),
  hookOf('UserPromptSubmit', 'hook prompt', 10),
];

// The matcher group a hook is written as (`matcher` first, as Claude Code
// writes them; the comparison below ignores key order).
const matcherGroupOf = (hook: ClaudeHook): JsonObject => ({
  ...(hook.matcher === undefined ? {} : { matcher: hook.matcher }),
  hooks: [{ type: 'command', command: hook.command, timeout: hook.timeout }],
});

// What the merge did to one event.
export type ClaudeHookChange = 'added' | 'updated';

export interface ClaudeSettingsPlan {
  // The whole file to write, 2-space JSON plus a trailing newline. Equal to
  // nothing in particular when `changed` is false: the caller writes nothing.
  readonly next: string;
  readonly changed: boolean;
  // One line per event that changed, in `CLAUDE_HOOKS` order.
  readonly changes: ReadonlyArray<{
    readonly event: ClaudeHookEvent;
    // The hook's `run`, so two hooks under one event read apart.
    readonly run: string;
    readonly change: ClaudeHookChange;
  }>;
}

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// A matcher group in the shape Claude Code writes: an object whose `hooks` is
// an array. Anything else under an event is kept as it is and never read.
type MatcherGroup = JsonObject & { readonly hooks: ReadonlyArray<unknown> };

const isMatcherGroup = (value: unknown): value is MatcherGroup =>
  isObject(value) && Array.isArray(value.hooks);

// A handler whose command is one of the hook's own spellings, exactly.
const isHandlerOf =
  (hook: ClaudeHook) =>
  (handler: unknown): boolean =>
    isObject(handler) &&
    typeof handler.command === 'string' &&
    hook.spellings.includes(handler.command.trim());

// A group is the hook's when one of its handlers is.
const isGroupOf =
  (hook: ClaudeHook) =>
  (group: unknown): group is MatcherGroup =>
    isMatcherGroup(group) && group.hooks.some(isHandlerOf(hook));

// Structural JSON equality, blind to key order: a canonical group whose keys
// Claude Code wrote back in another order is still canonical. Array order
// counts, as it does in JSON.
const jsonEqual = (a: unknown, b: unknown): boolean => {
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => jsonEqual(item, b[i]))
    );
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]))
    );
  }
  return a === b;
};

const decodeJson = Schema.decodeUnknownResult(
  Schema.fromJsonString(Schema.Unknown),
);

// Merge one event's matcher groups. The result keeps every foreign group
// where it was, strips the hook's handlers out of any group that also holds a
// foreign one (an operator's hand-merge), and puts the canonical group where
// the first of the hook's groups was found, or at the end. `undefined` =
// already canonical: exactly one handler of the hook's, in a group equal to
// the canonical one.
const mergeEvent = (
  groups: ReadonlyArray<unknown>,
  hook: ClaudeHook,
): ReadonlyArray<unknown> | undefined => {
  const canonical = matcherGroupOf(hook);
  const isOurGroup = isGroupOf(hook);
  const isOurHandler = isHandlerOf(hook);
  const ours = groups.filter(isOurGroup);
  const handlerCount = ours.reduce(
    (n, g) => n + g.hooks.filter(isOurHandler).length,
    0,
  );
  if (ours.length === 1 && handlerCount === 1 && jsonEqual(ours[0], canonical))
    return undefined;
  const next: Array<unknown> = [];
  let placed = false;
  for (const group of groups) {
    if (!isOurGroup(group)) {
      next.push(group);
      continue;
    }
    if (!placed) {
      next.push(canonical);
      placed = true;
    }
    const foreign = group.hooks.filter((h) => !isOurHandler(h));
    if (foreign.length > 0) next.push({ ...group, hooks: foreign });
  }
  if (!placed) next.push(canonical);
  return next;
};

// Merge the app's hook entries into the raw text of a settings file. `null`
// (no file) and a blank file both start from `{}`. Refuses — and so never
// overwrites — a file that is not a JSON object, a `hooks` that is not an
// object, or an event that is not an array: those are the operator's to fix,
// and a merge that guessed would lose what they hold.
//
// Untouched content keeps its key order: JSON.parse keeps insertion order for
// string keys and the merge edits `hooks` in place, so only a new key is
// appended (`hooks`, or an event under it). Integer-like keys are the one
// reordering JavaScript objects impose, and the one JSON allows.
export const planClaudeSettings = (
  raw: string | null,
): Result.Result<ClaudeSettingsPlan, string> => {
  let settings: JsonObject;
  if (raw === null || raw.trim() === '') {
    settings = {};
  } else {
    const decoded = decodeJson(raw);
    if (Result.isFailure(decoded)) {
      return Result.fail('settings.json is not valid JSON');
    }
    if (!isObject(decoded.success)) {
      return Result.fail('settings.json is not a JSON object');
    }
    settings = decoded.success;
  }
  const hooksIn = settings.hooks;
  if (hooksIn !== undefined && !isObject(hooksIn)) {
    return Result.fail('settings.json `hooks` is not an object');
  }
  const hooks: JsonObject = { ...(hooksIn ?? {}) };
  const changes: Array<ClaudeSettingsPlan['changes'][number]> = [];
  for (const hook of CLAUDE_HOOKS) {
    const groups = hooks[hook.event];
    if (groups !== undefined && !Array.isArray(groups)) {
      return Result.fail(
        `settings.json \`hooks.${hook.event}\` is not an array`,
      );
    }
    const merged = mergeEvent(groups ?? [], hook);
    if (merged === undefined) continue;
    hooks[hook.event] = merged;
    changes.push({
      event: hook.event,
      run: hook.run,
      change: (groups ?? []).some(isGroupOf(hook)) ? 'updated' : 'added',
    });
  }
  const next = changes.length === 0 ? settings : { ...settings, hooks };
  return Result.succeed({
    next: `${JSON.stringify(next, null, 2)}\n`,
    changed: changes.length > 0,
    changes,
  });
};
