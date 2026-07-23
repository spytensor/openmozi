import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const uiDist = resolve(process.cwd(), 'ui', 'dist');
const manifestPath = resolve(uiDist, '.vite', 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const entry = Object.values(manifest).find((chunk) => chunk?.isEntry === true);
if (!entry?.file) {
  throw new Error(`UI bundle manifest has no entry chunk: ${manifestPath}`);
}

const entryPath = resolve(uiDist, entry.file);
const entryBytes = statSync(entryPath).size;
const maxEntryBytes = 750_000;
if (entryBytes > maxEntryBytes) {
  throw new Error(`UI entry chunk is ${entryBytes} bytes; budget is ${maxEntryBytes} bytes (${entry.file})`);
}

console.log(`[ui-bundle] entry ${entry.file}: ${entryBytes} bytes (budget ${maxEntryBytes})`);
