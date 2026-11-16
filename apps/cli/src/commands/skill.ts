import path from 'node:path';
import { Console, Effect, FileSystem } from 'effect';
import { Command } from 'effect/cli';
import { InputError } from '../errors';
import { assetsDirOf, moduleDir, SKILL_FILE } from '../package-paths';

// `operator-inbox skill`: print the agent skill that ships with this CLI, so
// it can be installed into an agent's skills folder from the very version
// the agent will run (`operator-inbox skill > <skills dir>/SKILL.md`).

export const skillPath = (dir: string = moduleDir): string =>
  path.join(assetsDirOf(dir), SKILL_FILE);

export const readSkill = (dir: string = moduleDir) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = skillPath(dir);
    return yield* fs.readFileString(file).pipe(
      Effect.mapError(
        (e) =>
          new InputError({
            message: `could not read the skill at ${file}: ${e.message}`,
          }),
      ),
    );
  });

export const skillCommand = Command.make('skill', {}, () =>
  Effect.flatMap(readSkill(), (text) =>
    // The file's own trailing newline ends it; Console.log would add another.
    Console.log(text.endsWith('\n') ? text.slice(0, -1) : text),
  ),
).pipe(
  Command.withDescription('Print the agent skill that ships with this CLI'),
);
