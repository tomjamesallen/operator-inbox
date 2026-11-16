import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // Run on their own, serially, by `pnpm test-processes`: they spawn real
    // processes, which adds to the load that times out timing-sensitive suites.
    exclude: ['**/node_modules/**', '**/*.processes.test.ts'],
    passWithNoTests: true,
  },
});
