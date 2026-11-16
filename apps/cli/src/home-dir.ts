import { Config, Effect, Option } from 'effect';

// `$HOME`, read through `Config` like every other environment variable, so a
// test's ConfigProvider decides it and no read reaches the real home folder
// by another way. Unset or blank is none: each caller says what it cannot do
// without it.
export const readHome: Effect.Effect<Option.Option<string>> = Config.option(
  Config.String('HOME'),
).pipe(Effect.orDie, Effect.map(Option.filter((home) => home.trim() !== '')));
