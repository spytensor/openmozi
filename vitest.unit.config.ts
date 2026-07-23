import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 30_000,
    api: {
      host: '127.0.0.1',
    },
    exclude: [
      ...configDefaults.exclude,
      '**/.claude/worktrees/**',
      '**/*.integration.test.ts',
      '**/*.e2e.test.ts',
      'scripts/gate-e2e.test.ts',
      'ui/**',
    ],
  },
});
