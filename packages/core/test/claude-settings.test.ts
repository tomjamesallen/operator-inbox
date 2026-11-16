import { describe, expect, it } from '@effect/vitest';
import { Result } from 'effect';
import {
  CLAUDE_HOOKS,
  type ClaudeSettingsPlan,
  claudeSettingsPath,
  planClaudeSettings,
} from '../src/claude-settings';

// The pure settings merge behind `operator-inbox install-claude-hooks`: input
// text in, text out, no fixtures.

const plan = (raw: string | null): ClaudeSettingsPlan => {
  const result = planClaudeSettings(raw);
  if (Result.isFailure(result)) {
    throw new Error(`expected a plan, got: ${result.failure}`);
  }
  return result.success;
};

type Group = {
  readonly matcher?: string;
  readonly hooks: ReadonlyArray<{
    readonly type: string;
    readonly command: string;
    readonly timeout?: number;
  }>;
};
const hooksOf = (text: string) =>
  (JSON.parse(text) as { hooks: Record<string, ReadonlyArray<Group>> }).hooks;

const STOP = CLAUDE_HOOKS.find((h) => h.event === 'Stop');
const PRE_TOOL = CLAUDE_HOOKS.find(
  (h) => h.run === 'operator-inbox hook pre-tool',
);

// The operator's own SessionStart entry, as Herdr's integration writes it.
const HERDR_SESSION_START = {
  matcher: '*',
  hooks: [
    {
      type: 'command',
      command: "bash '/Users/x/.claude/hooks/herdr-agent-state.sh' session",
      timeout: 10,
    },
  ],
};

describe('claudeSettingsPath', () => {
  it('is settings.json under the home folder’s .claude', () => {
    expect(claudeSettingsPath('/Users/x')).toBe(
      '/Users/x/.claude/settings.json',
    );
  });
});

describe('CLAUDE_HOOKS', () => {
  it('holds the three inbox-mode hooks, each guarded on operator-inbox being on PATH', () => {
    expect(CLAUDE_HOOKS).toEqual([
      {
        event: 'Stop',
        run: 'operator-inbox guard',
        command:
          'command -v operator-inbox >/dev/null 2>&1 && operator-inbox guard || true',
        timeout: 30,
        spellings: [
          'command -v operator-inbox >/dev/null 2>&1 && operator-inbox guard || true',
          'operator-inbox guard',
        ],
      },
      {
        event: 'PreToolUse',
        matcher: 'AskUserQuestion|mcp__ccd_turn__wrap_up',
        run: 'operator-inbox hook pre-tool',
        command:
          'command -v operator-inbox >/dev/null 2>&1 && operator-inbox hook pre-tool || true',
        timeout: 10,
        spellings: [
          'command -v operator-inbox >/dev/null 2>&1 && operator-inbox hook pre-tool || true',
          'operator-inbox hook pre-tool',
        ],
      },
      {
        event: 'UserPromptSubmit',
        run: 'operator-inbox hook prompt',
        command:
          'command -v operator-inbox >/dev/null 2>&1 && operator-inbox hook prompt || true',
        timeout: 10,
        spellings: [
          'command -v operator-inbox >/dev/null 2>&1 && operator-inbox hook prompt || true',
          'operator-inbox hook prompt',
        ],
      },
    ]);
  });
});

describe('planClaudeSettings', () => {
  it('a missing or blank file gets the three hooks and nothing else', () => {
    for (const raw of [null, '', '  \n']) {
      const p = plan(raw);
      expect(p.changed).toBe(true);
      expect(p.changes).toEqual([
        { event: 'Stop', run: 'operator-inbox guard', change: 'added' },
        {
          event: 'PreToolUse',
          run: 'operator-inbox hook pre-tool',
          change: 'added',
        },
        {
          event: 'UserPromptSubmit',
          run: 'operator-inbox hook prompt',
          change: 'added',
        },
      ]);
      expect(Object.keys(JSON.parse(p.next))).toEqual(['hooks']);
      expect(hooksOf(p.next)).toEqual({
        Stop: [
          {
            hooks: [{ type: 'command', command: STOP?.command, timeout: 30 }],
          },
        ],
        PreToolUse: [
          {
            matcher: 'AskUserQuestion|mcp__ccd_turn__wrap_up',
            hooks: [
              { type: 'command', command: PRE_TOOL?.command, timeout: 10 },
            ],
          },
        ],
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: 'command',
                command:
                  'command -v operator-inbox >/dev/null 2>&1 && operator-inbox hook prompt || true',
                timeout: 10,
              },
            ],
          },
        ],
      });
      expect(p.next.endsWith('}\n')).toBe(true);
    }
  });

  it('keeps every foreign key, its value and its order', () => {
    const existing = {
      attribution: { commit: '' },
      permissions: { deny: ['Bash(env:*)'], allow: ['Read'] },
      model: 'opus',
      hooks: { SessionStart: [HERDR_SESSION_START] },
      statusLine: { type: 'command', command: '~/x.sh' },
      modelSettings: { 'claude-opus-5-5': { autoCompactWindow: 400000 } },
    };
    const p = plan(JSON.stringify(existing, null, 2));
    const next = JSON.parse(p.next) as Record<string, unknown>;
    expect(Object.keys(next)).toEqual(Object.keys(existing));
    for (const key of Object.keys(existing)) {
      if (key === 'hooks') continue;
      expect(next[key]).toEqual(existing[key as keyof typeof existing]);
    }
    const hooks = hooksOf(p.next);
    // The foreign event stays first and byte-for-byte the same.
    expect(Object.keys(hooks)).toEqual([
      'SessionStart',
      'Stop',
      'PreToolUse',
      'UserPromptSubmit',
    ]);
    expect(hooks.SessionStart).toEqual([HERDR_SESSION_START]);
  });

  it('keeps foreign entries under the same event, in place, beside its own', () => {
    const foreignStop = {
      hooks: [{ type: 'command', command: 'say done', timeout: 5 }],
    };
    const foreignPre = {
      matcher: 'Bash',
      hooks: [{ type: 'command', command: 'audit-bash' }],
    };
    const p = plan(
      JSON.stringify({
        hooks: { Stop: [foreignStop], PreToolUse: [foreignPre] },
      }),
    );
    const hooks = hooksOf(p.next);
    expect(hooks.Stop?.[0]).toEqual(foreignStop);
    expect(hooks.Stop?.[1]?.hooks[0]?.command).toBe(STOP?.command);
    expect(hooks.Stop).toHaveLength(2);
    expect(hooks.PreToolUse?.[0]).toEqual(foreignPre);
    expect(hooks.PreToolUse?.[1]?.matcher).toBe(PRE_TOOL?.matcher);
    expect(p.changes.map((c) => c.change)).toEqual(['added', 'added', 'added']);
  });

  it('updates a stale entry of its own in its own position and reports it', () => {
    const foreignBefore = {
      hooks: [{ type: 'command', command: 'echo before' }],
    };
    const foreignAfter = {
      hooks: [{ type: 'command', command: 'echo after' }],
    };
    const fresh = plan(null).next;
    const current = hooksOf(fresh);
    const stale = {
      hooks: {
        ...current,
        Stop: [
          foreignBefore,
          {
            hooks: [
              { type: 'command', command: 'operator-inbox guard', timeout: 5 },
            ],
          },
          foreignAfter,
        ],
      },
    };
    const p = plan(JSON.stringify(stale));
    expect(p.changes).toEqual([
      { event: 'Stop', run: 'operator-inbox guard', change: 'updated' },
    ]);
    const hooks = hooksOf(p.next);
    expect(hooks.Stop).toEqual([
      foreignBefore,
      current.Stop?.[0],
      foreignAfter,
    ]);
    // The other two events were already canonical and are untouched.
    expect(hooks.PreToolUse).toEqual(current.PreToolUse);
    expect(hooks.UserPromptSubmit).toEqual(current.UserPromptSubmit);
  });

  it('strips its own handler from a hand-merged group and keeps the foreign one', () => {
    const p = plan(
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                { type: 'command', command: 'say done' },
                { type: 'command', command: 'operator-inbox guard' },
              ],
            },
          ],
        },
      }),
    );
    const stop = hooksOf(p.next).Stop;
    expect(stop?.[0]?.hooks[0]?.command).toBe(STOP?.command);
    expect(stop?.[1]).toEqual({
      hooks: [{ type: 'command', command: 'say done' }],
    });
    expect(p.changes[0]).toEqual({
      event: 'Stop',
      run: 'operator-inbox guard',
      change: 'updated',
    });
  });

  it('collapses duplicate entries of its own to one', () => {
    const one = hooksOf(plan(null).next).Stop?.[0];
    const p = plan(JSON.stringify({ hooks: { Stop: [one, one] } }));
    expect(hooksOf(p.next).Stop).toEqual([one]);
    expect(p.changes[0]).toEqual({
      event: 'Stop',
      run: 'operator-inbox guard',
      change: 'updated',
    });
  });

  it('a re-run on what it wrote is a no-op, whatever the formatting', () => {
    const first = plan(
      JSON.stringify({
        model: 'opus',
        hooks: { SessionStart: [HERDR_SESSION_START] },
      }),
    );
    const second = plan(first.next);
    expect(second.changed).toBe(false);
    expect(second.changes).toEqual([]);
    expect(second.next).toBe(first.next);
    // Re-indented by hand: still recognised as up to date.
    const reformatted = JSON.stringify(JSON.parse(first.next), null, 4);
    expect(plan(reformatted).changed).toBe(false);
  });

  it('an entry whose keys were written back in another order is up to date', () => {
    // Every object's keys reversed, as a tool rewriting the file might.
    const reversed = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(reversed)
        : typeof value === 'object' && value !== null
          ? Object.fromEntries(
              Object.entries(value)
                .reverse()
                .map(([k, v]) => [k, reversed(v)]),
            )
          : value;
    const ours = JSON.parse(plan(null).next);
    const reordered = JSON.stringify(reversed(ours));
    // The reversal really did reorder the canonical PreToolUse group.
    expect(reordered).not.toBe(JSON.stringify(ours));
    expect(reordered).toContain('{"hooks":[{"timeout":10');
    expect(plan(reordered).changed).toBe(false);
    // The comparison still sees a changed value under the reordering.
    const stale = reordered.replace('"timeout":30', '"timeout":5');
    expect(plan(stale).changes).toEqual([
      { event: 'Stop', run: 'operator-inbox guard', change: 'updated' },
    ]);
  });

  it('refuses malformed JSON and wrong shapes rather than overwrite them', () => {
    for (const raw of [
      '{ "model": "opus", ',
      'not json',
      '[]',
      '"a string"',
      '{ "hooks": [] }',
      '{ "hooks": "nope" }',
      '{ "hooks": { "Stop": {} } }',
    ]) {
      const result = planClaudeSettings(raw);
      expect(Result.isFailure(result)).toBe(true);
    }
    const bad = planClaudeSettings('{ "hooks": { "Stop": {} } }');
    expect(Result.isFailure(bad) && bad.failure).toContain('hooks.Stop');
  });

  it('never treats the operator’s own operator-inbox hook as its own', () => {
    // Another subcommand of the same binary, in a hook the operator wrote.
    const watch = {
      hooks: [{ type: 'command', command: 'operator-inbox watch --session s' }],
    };
    const p = plan(JSON.stringify({ hooks: { Stop: [watch] } }));
    expect(hooksOf(p.next).Stop).toEqual([
      watch,
      { hooks: [{ type: 'command', command: STOP?.command, timeout: 30 }] },
    ]);
    expect(p.changes[0]).toEqual({
      event: 'Stop',
      run: 'operator-inbox guard',
      change: 'added',
    });
  });

  it('never treats another tool’s hook as its own', () => {
    // A command that only resembles the app's belongs to another tool.
    const actions = {
      hooks: [{ type: 'command', command: 'other-inbox hook session' }],
    };
    const p = plan(JSON.stringify({ hooks: { Stop: [actions] } }));
    expect(hooksOf(p.next).Stop?.[0]).toEqual(actions);
    expect(p.changes[0]).toEqual({
      event: 'Stop',
      run: 'operator-inbox guard',
      change: 'added',
    });
  });
});
