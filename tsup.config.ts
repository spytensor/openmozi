import { defineConfig } from 'tsup';
import { copyFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const productVersion = JSON.parse(readFileSync('package.json', 'utf8')).version as string;
const commit = process.env.MOZI_BUILD_COMMIT || (() => {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return 'unknown'; }
})();
const buildTime = process.env.MOZI_BUILD_TIME || new Date().toISOString();
const channel = process.env.MOZI_RELEASE_CHANNEL || (productVersion.includes('-') ? 'beta' : 'stable');

export default defineConfig({
  entry: ['src/**/*.ts', '!src/**/*.test.ts'],
  format: ['esm'],
  target: 'es2022',
  outDir: 'dist',
  clean: true,
  splitting: true,
  sourcemap: true,
  dts: false,
  external: ['better-sqlite3', 'playwright', 'playwright-core', 'chromium-bidi'],
  define: {
    __MOZI_VERSION__: JSON.stringify(productVersion),
    __MOZI_COMMIT__: JSON.stringify(commit),
    __MOZI_BUILD_TIME__: JSON.stringify(buildTime),
    __MOZI_CHANNEL__: JSON.stringify(channel),
  },
  onSuccess: async () => {
    writeFileSync('dist/build-info.json', `${JSON.stringify({ version: productVersion, commit, buildTime, channel }, null, 2)}\n`);
    // Copy non-TS assets to dist
    mkdirSync('dist/store', { recursive: true });
    copyFileSync('src/store/schema.sql', 'dist/store/schema.sql');

    // Copy template files for workspace scaffolding
    mkdirSync('dist/templates', { recursive: true });
    for (const file of ['SOUL.md', 'AGENTS.md']) {
      if (existsSync(`src/templates/${file}`)) {
        copyFileSync(`src/templates/${file}`, `dist/templates/${file}`);
      }
    }
  },
});
