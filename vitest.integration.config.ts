import { configDefaults, defineConfig } from 'vitest/config';
import dotenv from 'dotenv';

dotenv.config();

export default defineConfig({
  test: {
    testTimeout: 30_000,
    api: {
      host: '127.0.0.1',
    },
    include: [
      'src/**/*.integration.test.ts',
      'tests/**/*.integration.test.ts',
    ],
    exclude: [...configDefaults.exclude, '**/.claude/worktrees/**'],
  },
});
