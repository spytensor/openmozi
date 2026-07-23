import { readFileSync } from 'node:fs';

export function assertExpectedRuntimeOwner(health, expectedHome) {
  if (health?.mozi_home === expectedHome) return;
  throw new Error(`port already owned by ${health?.mozi_home ?? 'unknown runtime'}`);
}

export function readRuntimeLogOrPlaceholder(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '(runtime log was not created)';
    return `(runtime log unavailable: ${error instanceof Error ? error.message : String(error)})`;
  }
}
