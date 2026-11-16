import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect, it } from '@effect/vitest';
import { CLAUDE_HOOKS } from '@operator-inbox/core';
import { ConfigProvider, Console, Effect, FileSystem, Result } from 'effect';
import { Command } from 'effect/cli';
import { installClaudeHooksCommand } from '../src/commands/install-claude-hooks';
import { envProvider } from '../src/env-config';

// `operator-inbox install-claude-hooks` against a temp HOME. HOME comes from a ConfigProvider holding ONLY the temp
// dir, and the command requires it, so no case can reach the real
// ~/.claude/settings.json.

const tempHome = () =>
  mkdtempSync(path.join(tmpdir(), 'operator-inbox-claude-settings-'));

const run = (home: string) =>
  Effect.gen(function* () {
    const out: Array<string> = [];
    const base = yield* Console.consoleWith(Effect.succeed);
    const result = yield* Command.runWith(installClaudeHooksCommand, {
      version: '0.0.0',
    })([]).pipe(
      Effect.provideService(Console.Console, {
        ...base,
        log: (...args: ReadonlyArray<unknown>) => {
          out.push(args.join(' '));
        },
        error: (...args: ReadonlyArray<unknown>) => {
          out.push(args.join(' '));
        },
      }),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        envProvider({ HOME: home }),
      ),
      Effect.result,
    );
    return { result, out: out.join('\n') };
  });

const claudeDir = (home: string) => path.join(home, '.claude');
const settingsOf = (home: string) =>
  path.join(claudeDir(home), 'settings.json');
const backupsIn = (home: string) =>
  readdirSync(claudeDir(home)).filter((n) => n.includes('pre-operator-inbox'));

const FOREIGN = {
  model: 'opus',
  hooks: {
    SessionStart: [
      {
        matcher: '*',
        hooks: [{ type: 'command', command: 'herdr-agent-state', timeout: 10 }],
      },
    ],
  },
  statusLine: { type: 'command', command: '~/x.sh' },
};

describe('install-claude-hooks', () => {
  it.effect(
    'a fresh HOME gets a settings.json holding the three hooks, and no backup',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = tempHome();
        const { result, out } = yield* run(home);
        expect(Result.isSuccess(result)).toBe(true);
        const written = JSON.parse(
          yield* fs.readFileString(settingsOf(home)),
        ) as { hooks: Record<string, unknown> };
        expect(Object.keys(written.hooks)).toEqual([
          ...new Set(CLAUDE_HOOKS.map((h) => h.event)),
        ]);
        expect(out).toContain(
          '~/.claude/settings.json: Stop hook (operator-inbox guard) added',
        );
        expect(out).toContain(
          'PreToolUse hook (operator-inbox hook pre-tool) added',
        );
        expect(out).toContain(
          'UserPromptSubmit hook (operator-inbox hook prompt) added',
        );
        expect(out).not.toContain('backed up');
        expect(backupsIn(home)).toEqual([]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    'existing foreign settings are kept, backed up once, and a re-run is a no-op',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = tempHome();
        yield* fs.makeDirectory(claudeDir(home), { recursive: true });
        const original = `${JSON.stringify(FOREIGN, null, 2)}\n`;
        yield* fs.writeFileString(settingsOf(home), original);
        yield* fs.chmod(settingsOf(home), 0o600);

        const first = yield* run(home);
        expect(Result.isSuccess(first.result)).toBe(true);
        expect(first.out).toContain(
          'backed up to ~/.claude/settings.json.pre-operator-inbox',
        );
        // The backup is the original, byte for byte.
        expect(
          yield* fs.readFileString(`${settingsOf(home)}.pre-operator-inbox`),
        ).toBe(original);
        const after = yield* fs.readFileString(settingsOf(home));
        const parsed = JSON.parse(after) as typeof FOREIGN & {
          hooks: Record<string, unknown>;
        };
        expect(Object.keys(parsed)).toEqual(Object.keys(FOREIGN));
        expect(parsed.model).toBe('opus');
        expect(parsed.statusLine).toEqual(FOREIGN.statusLine);
        expect(parsed.hooks.SessionStart).toEqual(FOREIGN.hooks.SessionStart);
        // Permission bits carried across the atomic rename; no staging file left.
        expect((yield* fs.stat(settingsOf(home))).mode & 0o777).toBe(0o600);
        expect(readdirSync(claudeDir(home)).sort()).toEqual([
          'settings.json',
          'settings.json.pre-operator-inbox',
        ]);

        const second = yield* run(home);
        expect(Result.isSuccess(second.result)).toBe(true);
        expect(second.out).toContain('already up to date');
        expect(yield* fs.readFileString(settingsOf(home))).toBe(after);
        expect(backupsIn(home)).toEqual(['settings.json.pre-operator-inbox']);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    'a later update backs up again at the next free name, never over the first',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = tempHome();
        yield* fs.makeDirectory(claudeDir(home), { recursive: true });
        yield* fs.writeFileString(settingsOf(home), JSON.stringify(FOREIGN));
        yield* run(home);
        const firstBackup = yield* fs.readFileString(
          `${settingsOf(home)}.pre-operator-inbox`,
        );
        // A stale entry of the app's, in an older spelling.
        const stale = JSON.parse(
          yield* fs.readFileString(settingsOf(home)),
        ) as { hooks: Record<string, unknown> };
        stale.hooks.Stop = [
          { hooks: [{ type: 'command', command: 'operator-inbox guard' }] },
        ];
        yield* fs.writeFileString(settingsOf(home), JSON.stringify(stale));
        const { out } = yield* run(home);
        expect(out).toContain('Stop hook (operator-inbox guard) updated');
        expect(out).toContain('.pre-operator-inbox.2');
        expect(
          yield* fs.readFileString(`${settingsOf(home)}.pre-operator-inbox`),
        ).toBe(firstBackup);
        expect(backupsIn(home).sort()).toEqual([
          'settings.json.pre-operator-inbox',
          'settings.json.pre-operator-inbox.2',
        ]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    'a user’s own Stop hook running operator-inbox watch survives, on every run',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = tempHome();
        const watch = {
          hooks: [
            {
              type: 'command',
              command: 'operator-inbox watch --session "$SESSION" &',
              timeout: 5,
            },
          ],
        };
        yield* fs.makeDirectory(claudeDir(home), { recursive: true });
        yield* fs.writeFileString(
          settingsOf(home),
          JSON.stringify({ hooks: { Stop: [watch] } }),
        );
        const stopOf = Effect.map(
          fs.readFileString(settingsOf(home)),
          (text) =>
            (JSON.parse(text) as { hooks: { Stop: Array<unknown> } }).hooks
              .Stop,
        );
        const first = yield* run(home);
        expect(Result.isSuccess(first.result)).toBe(true);
        expect(first.out).toContain('Stop hook (operator-inbox guard) added');
        const afterFirst = yield* stopOf;
        expect(afterFirst[0]).toEqual(watch);
        expect(afterFirst).toHaveLength(2);
        // The re-run sees its own entry up to date and the user's as foreign.
        yield* run(home);
        expect(yield* stopOf).toEqual(afterFirst);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect('a second run on a fresh HOME writes nothing at all', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = tempHome();
      yield* run(home);
      const first = yield* fs.readFileString(settingsOf(home));
      const second = yield* run(home);
      expect(Result.isSuccess(second.result)).toBe(true);
      expect(second.out).toBe(
        '~/.claude/settings.json: operator-inbox hooks already up to date',
      );
      expect(yield* fs.readFileString(settingsOf(home))).toBe(first);
      expect(readdirSync(claudeDir(home))).toEqual(['settings.json']);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect('refuses malformed JSON and leaves the file untouched', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = tempHome();
      yield* fs.makeDirectory(claudeDir(home), { recursive: true });
      const broken = '{ "model": "opus", ';
      yield* fs.writeFileString(settingsOf(home), broken);
      const { result } = yield* run(home);
      expect(Result.isFailure(result)).toBe(true);
      expect(
        Result.isFailure(result) && String(result.failure.message),
      ).toContain('left unchanged');
      expect(yield* fs.readFileString(settingsOf(home))).toBe(broken);
      expect(backupsIn(home)).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect('writes through a symlinked settings.json and keeps the link', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = tempHome();
      yield* fs.makeDirectory(claudeDir(home), { recursive: true });
      const real = path.join(home, 'dotfiles-settings.json');
      yield* fs.writeFileString(real, JSON.stringify(FOREIGN));
      yield* fs.symlink(real, settingsOf(home));
      yield* run(home);
      expect(yield* fs.readLink(settingsOf(home))).toBe(real);
      expect(yield* fs.readFileString(real)).toContain('operator-inbox guard');
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect('fails rather than guess when HOME is not set', () =>
    Effect.gen(function* () {
      const result = yield* Command.runWith(installClaudeHooksCommand, {
        version: '0.0.0',
      })([]).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, envProvider({})),
        Effect.result,
      );
      expect(Result.isFailure(result)).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
