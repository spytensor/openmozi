import { defineConfig, configDefaults } from 'vitest/config';
import dotenv from 'dotenv';

// Load .env for local runs (integration tests may rely on API keys).
dotenv.config();

export default defineConfig({
  test: {
    testTimeout: 30_000,
    api: {
      host: '127.0.0.1',
    },
    // Extend (never replace) the defaults: a bare `exclude` override drops
    // the built-in node_modules exclusion, which makes vitest walk the
    // packaged dependency test suites under desktop/resources/mozi.
    exclude: [
      ...configDefaults.exclude,
      'ui/**',
      '**/.claude/worktrees/**',
      'desktop/**',
    ],
  },
});
