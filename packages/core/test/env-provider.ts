import { ConfigProvider } from 'effect';

// The test environment, read the way the shipped bin reads the process
// environment: env-variable semantics, empty strings KEPT (Effect 4's default
// reads `export FOO=` as unset; the bin keeps it as ''). The record is the
// WHOLE environment, so nothing from the developer's shell leaks into a case.
export const envProvider = (
  overrides: Record<string, string> = {},
): ConfigProvider.ConfigProvider =>
  ConfigProvider.fromEnvRecord(overrides, { preserveEmptyStrings: true });
