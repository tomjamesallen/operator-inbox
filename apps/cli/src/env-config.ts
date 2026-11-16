import { ConfigProvider } from 'effect';

// The shipped bin's empty-string behaviour for environment `Config` reads,
// shared with the tests. Effect 4's env provider reads an empty variable
// (`export FOO=`) as unset unless told to keep it. The app keeps it, so each
// read decides what an empty value means (a blank `XDG_*` counts as unset, as
// the XDG spec says), and a test that hands a provider an empty value sees
// what the bin would see.
const keepEmptyStrings = { preserveEmptyStrings: true };

/** The process environment, as the shipped bin reads it. */
export const processEnvProvider = (): ConfigProvider.ConfigProvider =>
  ConfigProvider.fromEnv(keepEmptyStrings);

/**
 * An environment made of `overrides`, read with the same semantics as the
 * process environment (`fromEnvRecord`), empty strings kept.
 *
 * Without `fallBackToEnv` the record is the WHOLE environment, so nothing from
 * the developer's own shell can leak into a case. With it, a name the record
 * does not hold falls through to the process environment.
 */
export const envProvider = (
  overrides: Record<string, string> = {},
  options?: { readonly fallBackToEnv?: boolean },
): ConfigProvider.ConfigProvider => {
  const own = ConfigProvider.fromEnvRecord(overrides, keepEmptyStrings);
  return options?.fallBackToEnv === true
    ? own.pipe(ConfigProvider.orElse(processEnvProvider()))
    : own;
};
