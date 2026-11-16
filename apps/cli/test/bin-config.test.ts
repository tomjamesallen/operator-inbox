import { describe, expect, it } from '@effect/vitest';
import { ConfigProvider, Effect } from 'effect';
import { binConfig } from '../src/bin-config';
import { envProvider } from '../src/env-config';

// The herdr, ssh and lsof overrides: an empty value is the default binary,
// never the binary ''.
describe('binConfig', () => {
  it.effect('reads an override, and an unset or empty one as the default', () =>
    Effect.gen(function* () {
      const read = (env: Record<string, string>) =>
        Effect.all([
          binConfig('OPERATOR_INBOX_HERDR_BIN', 'herdr'),
          binConfig('OPERATOR_INBOX_SSH_BIN', 'ssh'),
          binConfig('OPERATOR_INBOX_LSOF_BIN', 'lsof'),
        ]).pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            envProvider(env),
          ),
        );
      expect(yield* read({})).toEqual(['herdr', 'ssh', 'lsof']);
      expect(
        yield* read({
          OPERATOR_INBOX_HERDR_BIN: '',
          OPERATOR_INBOX_SSH_BIN: '',
          OPERATOR_INBOX_LSOF_BIN: '',
        }),
      ).toEqual(['herdr', 'ssh', 'lsof']);
      expect(
        yield* read({
          OPERATOR_INBOX_HERDR_BIN: '/stub/herdr',
          OPERATOR_INBOX_SSH_BIN: '/stub/ssh',
          OPERATOR_INBOX_LSOF_BIN: '/stub/lsof',
        }),
      ).toEqual(['/stub/herdr', '/stub/ssh', '/stub/lsof']);
    }),
  );
});
