import { defineConfig } from 'vitest/config';

// The suites that spawn real processes (`*.processes.test.ts`), run alone and
// serially by `pnpm test-processes` — never beside the main suites, whose
// timeouts they would starve. See `vitest.config.ts`, which excludes them.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.processes.test.ts', 'test/**/*.processes.test.ts'],
    fileParallelism: false,
  },
});
