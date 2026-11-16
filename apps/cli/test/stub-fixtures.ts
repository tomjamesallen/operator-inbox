import path from 'node:path';
import { Effect, FileSystem } from 'effect';

// A stand-in for a bin the CLI shells out to, used across the CLI suite.
//
// Write an executable stub shell script `name` into a fresh temp dir and return
// its absolute path (chmod 0o755 so the executor can spawn it directly). Every
// bin the CLI shells out to is Config-overridable, so a test points that Config
// at one of these instead of the real binary. `name` is a parameter because it
// is what the bin is called in any spawn diagnostic, and a caller wiring
// several bins at once needs them told apart.
export const writeStubBin = (name: string, body: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectory();
    const bin = path.join(dir, name);
    yield* fs.writeFileString(bin, body);
    yield* fs.chmod(bin, 0o755);
    return bin;
  });
