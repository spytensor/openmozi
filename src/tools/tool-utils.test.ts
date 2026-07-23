import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  workspaceDir: '/tmp/mozi-tool-utils-ws',
  workspaceOnly: true,
  mockExistsSync: null as ((path: string) => boolean) | null,
}));

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal() as typeof import('node:fs');
  return {
    ...original,
    existsSync: (path: string) => {
      if (hoisted.mockExistsSync) return hoisted.mockExistsSync(path);
      return original.existsSync(path);
    },
  };
});

vi.mock('../config/index.js', () => ({
  getConfig: () => ({
    workspace: { dir: hoisted.workspaceDir },
    tools: {
      fs: {
        workspace_only: hoisted.workspaceOnly,
        allow_project_root_read: true,
        additional_allowed_roots: ['~/.mozi'],
      },
    },
  }),
}));

import { expandHome, resolveReadPath, resolveWritePath, assertFsPathAllowed, PathScopeError, SensitiveWriteError, resolveWriteRoots, isFullAccessContext } from './tool-utils.js';
import type { ToolContext } from './types.js';

describe('tools/tool-utils path normalization', () => {
  it('expands full-width tilde to home directory', () => {
    expect(expandHome('～/.mozi/logs')).toBe(resolve(homedir(), '.mozi/logs'));
  });

  it('treats bare .mozi/* path as implicit home-relative path', () => {
    expect(resolveReadPath('.mozi/logs')).toBe(resolve(homedir(), '.mozi/logs'));
  });
});

describe('resolveWritePath — relative paths always go to workspace', () => {
  it('resolves relative path to workspace even when workspace_only is false', () => {
    hoisted.workspaceOnly = false;
    // A plain relative filename must always land in workspace, never project root
    const result = resolveWritePath('notes.md');
    expect(result).toBe(resolve(hoisted.workspaceDir, 'notes.md'));
  });

  it('resolves relative subdir path to workspace', () => {
    hoisted.workspaceOnly = false;
    const result = resolveWritePath('sub/dir/file.txt');
    expect(result).toBe(resolve(hoisted.workspaceDir, 'sub/dir/file.txt'));
  });

  it('strips workspace/ prefix before resolving', () => {
    hoisted.workspaceOnly = false;
    const result = resolveWritePath('workspace/readme.md');
    expect(result).toBe(resolve(hoisted.workspaceDir, 'readme.md'));
  });

  it('resolves absolute path as-is', () => {
    hoisted.workspaceOnly = false;
    const result = resolveWritePath('/tmp/some-file.txt');
    expect(result).toBe('/tmp/some-file.txt');
  });

  it('resolves .mozi/* to home directory', () => {
    hoisted.workspaceOnly = false;
    const result = resolveWritePath('.mozi/data/cache.json');
    expect(result).toBe(resolve(homedir(), '.mozi/data/cache.json'));
  });

  it('resolves ~ path to expanded home', () => {
    hoisted.workspaceOnly = false;
    const result = resolveWritePath('~/some-file.txt');
    expect(result).toBe(resolve(homedir(), 'some-file.txt'));
  });
});

describe('write scope — project-scoped writes (P2)', () => {
  const projectRoot = '/tmp/mozi-proj-scope/alpha';

  it('allows a relative write inside the scoped project root', () => {
    hoisted.workspaceOnly = true;
    const result = resolveWritePath('report.txt', 'u', [projectRoot], projectRoot);
    expect(result).toBe(resolve(projectRoot, 'report.txt'));
  });

  it('allows an absolute write inside the scoped project root', () => {
    hoisted.workspaceOnly = true;
    const target = resolve(projectRoot, 'sub/a.txt');
    expect(resolveWritePath(target, 'u', [projectRoot], projectRoot)).toBe(target);
  });

  it('BLOCKS an absolute write outside the scoped project root', () => {
    hoisted.workspaceOnly = true;
    expect(() => resolveWritePath('/etc/evil.txt', 'u', [projectRoot], projectRoot)).toThrow(PathScopeError);
  });

  it('BLOCKS a write into a sibling project outside scope', () => {
    hoisted.workspaceOnly = true;
    expect(() => resolveWritePath('/tmp/mozi-proj-scope/beta/x.txt', 'u', [projectRoot], projectRoot)).toThrow(PathScopeError);
  });

  it('assertFsPathAllowed uses the override and throws PathScopeError with the target', () => {
    hoisted.workspaceOnly = true;
    try {
      assertFsPathAllowed('/tmp/outside/x', '/tmp/outside/x', 'u', [projectRoot]);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PathScopeError);
      expect((err as PathScopeError).targetPath).toBe('/tmp/outside/x');
    }
  });

  it('does not restrict when workspace_only is off', () => {
    hoisted.workspaceOnly = false;
    expect(() => resolveWritePath('/etc/anything.txt', 'u', [projectRoot], projectRoot)).not.toThrow();
  });
});

describe('write scope × permission level — L3 bypasses project-scope gate (BUG-1 root cause)', () => {
  const projectRoot = '/tmp/mozi-proj-scope/alpha';
  const outsideScopeInWorkspace = resolve(hoisted.workspaceDir, 'build_template.py');

  // Legacy single-user id ('') makes getWorkspaceDir resolve to the mocked
  // config workspace dir deterministically (non-legacy ids route to the
  // per-user sandbox path instead).
  function ctx(level: string): ToolContext {
    return {
      userId: '',
      permissionLevel: level,
      workspaceRootPath: projectRoot,
    } as ToolContext;
  }

  it('isFullAccessContext is true only for L3_FULL_ACCESS', () => {
    expect(isFullAccessContext(ctx('L3_FULL_ACCESS'))).toBe(true);
    expect(isFullAccessContext(ctx('L2_SHELL_EXEC'))).toBe(false);
    expect(isFullAccessContext(ctx('L1_READ_WRITE'))).toBe(false);
    expect(isFullAccessContext(ctx('L0_READ_ONLY'))).toBe(false);
    expect(isFullAccessContext(ctx('garbage'))).toBe(false);
    expect(isFullAccessContext(undefined)).toBe(false);
  });

  it('L1 (project-scoped) narrows write roots to the project root — a workspace path outside the project is BLOCKED', () => {
    hoisted.workspaceOnly = true;
    const roots = resolveWriteRoots(ctx('L1_READ_WRITE'));
    // Scoped: roots are the project root (+ output dir), NOT the global workspace.
    expect(roots).toContain(resolve(projectRoot));
    expect(roots).not.toContain(resolve(hoisted.workspaceDir));
    // A write to /data/workspace/build_template.py (the live failing path shape)
    // is outside those roots → PathScopeError → approval prompt fires.
    expect(() => resolveWritePath(outsideScopeInWorkspace, '', roots, projectRoot)).toThrow(PathScopeError);
  });

  it('L3 (full access) does NOT narrow to the project root — the same workspace write is ALLOWED with no approval', () => {
    hoisted.workspaceOnly = true;
    const roots = resolveWriteRoots(ctx('L3_FULL_ACCESS'));
    // Full access: roots are the global workspace policy, including the
    // workspace dir — the project narrowing is gone.
    expect(roots).toContain(resolve(hoisted.workspaceDir));
    // The exact live failure no longer throws — L3 writes anywhere the global
    // workspace policy allows, without the scope-approval gate.
    expect(() => resolveWritePath(outsideScopeInWorkspace, '', roots, projectRoot)).not.toThrow();
    expect(resolveWritePath(outsideScopeInWorkspace, '', roots, projectRoot)).toBe(outsideScopeInWorkspace);
  });

  it('L3 is still bounded by workspace_only — full access is not "any path on disk"', () => {
    hoisted.workspaceOnly = true;
    const roots = resolveWriteRoots(ctx('L3_FULL_ACCESS'));
    // /etc is outside even the global workspace roots — still blocked at L3.
    expect(() => resolveWritePath('/etc/evil.txt', '', roots, projectRoot)).toThrow(PathScopeError);
  });
});

describe('write scope — approved out-of-scope grants are honored (approval is not a dead end)', () => {
  const grantDir = '/tmp/mozi-approved-out-of-scope';

  it('merges an approved grant dir into write roots when NO project is selected', () => {
    hoisted.workspaceOnly = true;
    const roots = resolveWriteRoots({ userId: 'u1', scopeGrants: [grantDir] } as ToolContext) ?? [];
    expect(roots).toContain(resolve(grantDir));
    // The approved retry now actually writes into the granted dir instead of re-throwing.
    const target = resolve(grantDir, 'deck.pptx');
    expect(resolveWritePath(target, 'u1', roots)).toBe(target);
  });

  it('merges an approved grant dir into write roots at full access (L3)', () => {
    hoisted.workspaceOnly = true;
    const roots = resolveWriteRoots({ userId: 'u1', permissionLevel: 'L3_FULL_ACCESS', scopeGrants: [grantDir] } as ToolContext) ?? [];
    expect(roots).toContain(resolve(grantDir));
  });

  it('ignores non-path grant sentinels (e.g. the L1 write-session marker)', () => {
    hoisted.workspaceOnly = true;
    const roots = resolveWriteRoots({ userId: 'u1', scopeGrants: ['__l1_write_granted__'] } as ToolContext) ?? [];
    expect(roots.some((r) => r.includes('__l1_write_granted__'))).toBe(false);
  });
});

describe('write scope — full access opens MOZI home, but secrets/keys/DB stay hard-protected (option B)', () => {
  const home = resolve('/tmp/mozi-home-b-test');
  const prevHome = process.env.MOZI_HOME;

  function restoreHome() {
    if (prevHome === undefined) delete process.env.MOZI_HOME;
    else process.env.MOZI_HOME = prevHome;
  }
  const l3 = { userId: 'u1', permissionLevel: 'L3_FULL_ACCESS' } as ToolContext;

  it('full access adds the whole MOZI home to write roots', () => {
    process.env.MOZI_HOME = home;
    hoisted.workspaceOnly = true;
    try {
      expect(resolveWriteRoots(l3) ?? []).toContain(home);
    } finally { restoreHome(); }
  });

  it('below full access does NOT add the MOZI home', () => {
    process.env.MOZI_HOME = home;
    hoisted.workspaceOnly = true;
    try {
      const roots = resolveWriteRoots({ userId: 'u1', permissionLevel: 'L1_READ_WRITE' } as ToolContext) ?? [];
      expect(roots).not.toContain(home);
    } finally { restoreHome(); }
  });

  it('allows a normal MOZI-home write at full access (workspace/skills/...) with no approval', () => {
    process.env.MOZI_HOME = home;
    hoisted.workspaceOnly = true;
    try {
      const roots = resolveWriteRoots(l3);
      const target = resolve(home, 'workspace/skills/pptx/SKILL.md');
      expect(resolveWritePath(target, 'u1', roots)).toBe(target);
    } finally { restoreHome(); }
  });

  it('BLOCKS writes to secrets/keys/DB even at full access', () => {
    process.env.MOZI_HOME = home;
    hoisted.workspaceOnly = true;
    try {
      const roots = resolveWriteRoots(l3);
      for (const p of [
        resolve(home, '.env'),
        resolve(home, 'secrets.enc'),
        resolve(home, '.master-key'),
        resolve(home, 'jwt-secret'),
        resolve(home, 'data/mozi.db'),
      ]) {
        expect(() => resolveWritePath(p, 'u1', roots)).toThrow(SensitiveWriteError);
      }
    } finally { restoreHome(); }
  });
});

describe('resolveReadPath — repo name prefix stripping', () => {
  it('strips project name prefix and resolves against project root', () => {
    hoisted.workspaceOnly = false;
    // Simulate: workspace path doesn't exist, but project-root-relative path does
    const projectRoot = resolve(__dirname, '..', '..');
    hoisted.mockExistsSync = (path: string) => {
      // Only the stripped path (project root + relative) exists
      if (path === resolve(projectRoot, 'src/tools/tool-utils.ts')) return true;
      return false;
    };
    try {
      const result = resolveReadPath('Mozi/src/tools/tool-utils.ts');
      expect(result).toBe(resolve(projectRoot, 'src/tools/tool-utils.ts'));
    } finally {
      hoisted.mockExistsSync = null;
    }
  });

  it('strips repos/ProjectName prefix', () => {
    hoisted.workspaceOnly = false;
    const projectRoot = resolve(__dirname, '..', '..');
    hoisted.mockExistsSync = (path: string) => {
      if (path === resolve(projectRoot, 'src/tools/tool-utils.ts')) return true;
      return false;
    };
    try {
      const result = resolveReadPath('repos/Mozi/src/tools/tool-utils.ts');
      expect(result).toBe(resolve(projectRoot, 'src/tools/tool-utils.ts'));
    } finally {
      hoisted.mockExistsSync = null;
    }
  });
});

describe('resolveReadPath — reads honor the SELECTED project (read/write symmetry)', () => {
  const selectedProject = '/tmp/mozi-selected-project';

  it('resolves a relative read under the selected project, not the App Support workspace', () => {
    hoisted.workspaceOnly = true;
    hoisted.mockExistsSync = (path: string) => path === resolve(selectedProject, 'src/index.ts');
    try {
      const result = resolveReadPath('src/index.ts', undefined, selectedProject);
      expect(result).toBe(resolve(selectedProject, 'src/index.ts'));
    } finally {
      hoisted.mockExistsSync = null;
    }
  });

  it('allows an absolute read of the selected project that workspace_only would otherwise block', () => {
    hoisted.workspaceOnly = true;
    const abs = resolve(selectedProject, 'README.md');
    // Without the selected project the path is outside the allow-list → blocked.
    expect(() => resolveReadPath(abs)).toThrow(PathScopeError);
    // With the selected project it is an allowed read root.
    expect(resolveReadPath(abs, undefined, selectedProject)).toBe(abs);
  });
});
