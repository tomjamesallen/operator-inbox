import { describe, expect, it } from '@effect/vitest';
import { Result } from 'effect';
import {
  describeInboxDatabase,
  INBOX_DATABASE_PATH_VAR,
  resolveInboxDatabase,
  stateHome,
} from '../src/inbox-database';

// Where the inbox's SQLite file is: precedence, empty values, and the refusal
// of a path that is not absolute.

const STATE = '/home/me/.local/state';
const HOME = '/home/me';

describe('resolveInboxDatabase', () => {
  it('takes the env var over config.json and the default', () => {
    expect(
      resolveInboxDatabase({
        env: '/srv/env.sqlite',
        configPath: '/srv/config.sqlite',
        xdgStateHome: STATE,
        home: HOME,
      }),
    ).toEqual(Result.succeed({ source: 'env', path: '/srv/env.sqlite' }));
  });

  it('takes config.json when the env var is unset', () => {
    expect(
      resolveInboxDatabase({
        env: undefined,
        configPath: '/srv/config.sqlite',
        xdgStateHome: STATE,
        home: HOME,
      }),
    ).toEqual(Result.succeed({ source: 'config', path: '/srv/config.sqlite' }));
  });

  it('falls back to operator-inbox/inbox.sqlite under XDG_STATE_HOME', () => {
    expect(
      resolveInboxDatabase({
        env: undefined,
        configPath: undefined,
        xdgStateHome: STATE,
        home: HOME,
      }),
    ).toEqual(
      Result.succeed({
        source: 'default',
        path: '/home/me/.local/state/operator-inbox/inbox.sqlite',
      }),
    );
  });

  it('treats an empty or blank value at either rung as unset', () => {
    expect(
      resolveInboxDatabase({
        env: '  ',
        configPath: '',
        xdgStateHome: STATE,
        home: HOME,
      }),
    ).toEqual(
      Result.succeed({
        source: 'default',
        path: '/home/me/.local/state/operator-inbox/inbox.sqlite',
      }),
    );
  });

  it('refuses a relative or ~ override, naming where it came from', () => {
    const relative = resolveInboxDatabase({
      env: 'inbox.sqlite',
      configPath: undefined,
      xdgStateHome: STATE,
      home: HOME,
    });
    expect(Result.isFailure(relative) && relative.failure).toContain(
      INBOX_DATABASE_PATH_VAR,
    );
    const tilde = resolveInboxDatabase({
      env: undefined,
      configPath: '~/inbox.sqlite',
      xdgStateHome: STATE,
      home: HOME,
    });
    expect(Result.isFailure(tilde) && tilde.failure).toContain(
      "config.json's databasePath",
    );
  });

  it('does not fall through to a lower rung when the higher one is refused', () => {
    // A bad env override must fail loud, not quietly use config.json's file.
    const r = resolveInboxDatabase({
      env: 'relative.sqlite',
      configPath: '/srv/config.sqlite',
      xdgStateHome: STATE,
      home: HOME,
    });
    expect(Result.isFailure(r)).toBe(true);
  });
});

describe('the default path', () => {
  it('counts a blank or relative XDG_STATE_HOME as unset, so it stays absolute', () => {
    for (const xdgStateHome of [undefined, '', '  ', 'relative/state']) {
      expect(
        resolveInboxDatabase({
          env: undefined,
          configPath: undefined,
          xdgStateHome,
          home: HOME,
        }),
      ).toEqual(
        Result.succeed({
          source: 'default',
          path: '/home/me/.local/state/operator-inbox/inbox.sqlite',
        }),
      );
    }
  });

  it('uses an absolute XDG_STATE_HOME', () => {
    expect(
      resolveInboxDatabase({
        env: undefined,
        configPath: undefined,
        xdgStateHome: '/xdg/state',
        home: HOME,
      }),
    ).toEqual(
      Result.succeed({
        source: 'default',
        path: '/xdg/state/operator-inbox/inbox.sqlite',
      }),
    );
  });
});

describe('stateHome', () => {
  it('takes an absolute XDG_STATE_HOME, and <home>/.local/state for anything else', () => {
    expect(stateHome({ xdgStateHome: '/xdg', home: HOME })).toBe('/xdg');
    for (const xdgStateHome of [undefined, '', '  ', 'rel'])
      expect(stateHome({ xdgStateHome, home: HOME })).toBe(
        '/home/me/.local/state',
      );
  });
});

describe('describeInboxDatabase', () => {
  it('prints the default path alone, and an override with its source', () => {
    expect(
      describeInboxDatabase({ source: 'default', path: '/s/inbox.sqlite' }),
    ).toBe('/s/inbox.sqlite');
    expect(
      describeInboxDatabase({ source: 'env', path: '/srv/e.sqlite' }),
    ).toBe(`/srv/e.sqlite (set by ${INBOX_DATABASE_PATH_VAR})`);
    expect(
      describeInboxDatabase({ source: 'config', path: '/srv/c.sqlite' }),
    ).toBe("/srv/c.sqlite (set by config.json's databasePath)");
  });
});
