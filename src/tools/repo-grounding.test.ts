import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import {
  createRepoInspectionState,
  maybeEnableRepoInspection,
  recordGroundedRead,
  resolveInspectionDirectoryPath,
  resolveInspectionReadPath,
} from './repo-grounding.js';

describe('tools/repo-grounding', () => {
  it('resolves real repo modules by pragmatic repo lookup', () => {
    const state = createRepoInspectionState(true);
    const result = resolveInspectionReadPath('context-builder.ts', state);

    expect(['repo_lookup', 'exact']).toContain(result.reason);
    expect(result.resolvedPath).toBe(resolve('src/memory/context-builder.ts'));
  });

  it('follows relative imports from the last grounded file', () => {
    const state = createRepoInspectionState(true);
    recordGroundedRead(state, resolve('src/gateway/handler.ts'));

    const result = resolveInspectionReadPath('./session.ts', state);

    expect(result.reason).toBe('import_follow');
    expect(result.resolvedPath).toBe(resolve('src/gateway/session.ts'));
  });

  it('auto-enables repo inspection for repo-like paths and fixes fuzzy module names', () => {
    const state = createRepoInspectionState(false);
    maybeEnableRepoInspection(state, 'src/tools/shell-tools.ts');

    expect(state.enabled).toBe(true);
    const result = resolveInspectionReadPath('src/tools/shell-tools.ts', state);
    expect(['repo_lookup', 'exact']).toContain(result.reason);
    expect(result.resolvedPath).toBe(resolve('src/tools/shell-tools.ts'));
  });

  it('grounds redundant repo prefixes for directory inspection', () => {
    const state = createRepoInspectionState(true);
    const result = resolveInspectionDirectoryPath('workspace/repos/Mozi/src', state);

    expect(result.reason).toBe('exact');
    expect(result.resolvedPath).toBe(resolve('src'));
  });
});
