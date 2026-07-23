import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  workspaceDir: '',
  additionalAllowedRoots: [] as string[],
  workspaceOnly: true,
}));

vi.mock('../config/index.js', () => ({
  getConfig: () => ({
    workspace: { dir: hoisted.workspaceDir },
    tools: {
      fs: {
        workspace_only: hoisted.workspaceOnly,
        allow_project_root_read: true,
        additional_allowed_roots: hoisted.additionalAllowedRoots,
      },
    },
    security: { default_permission: 'L2_SHELL_EXEC' },
  }),
}));

import { exec } from './shell.js';

describe('capabilities/shell workspace boundary', () => {
  let workspaceDir: string;
  let outsideDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), 'mozi-shell-ws-'));
    outsideDir = mkdtempSync(join(tmpdir(), 'mozi-shell-outside-'));
    hoisted.workspaceDir = workspaceDir;
    hoisted.additionalAllowedRoots = [];
    hoisted.workspaceOnly = true;
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it('defaults cwd to the configured workspace directory', async () => {
    const result = await exec('pwd');

    expect(result.blocked).toBe(false);
    expect(realpathSync(result.stdout.trim())).toBe(realpathSync(workspaceDir));
  });

  it('rejects cwd outside allowed roots for L2 shell execution', async () => {
    const result = await exec('pwd', {
      cwd: outsideDir,
      enforceWorkspaceBoundary: true,
      permissionLevel: 'L2_SHELL_EXEC',
    });

    expect(result.blocked).toBe(true);
    expect(result.stderr).toContain('Shell is restricted to the workspace');
    expect(result.stderr).toContain(workspaceDir);
  });

  it('rejects absolute command paths outside allowed roots for L2 shell execution', async () => {
    const result = await exec('cat /etc/passwd', {
      enforceWorkspaceBoundary: true,
      permissionLevel: 'L2_SHELL_EXEC',
    });

    expect(result.blocked).toBe(true);
    expect(result.stderr).toContain('Shell is restricted to the workspace');
  });

  it('rejects cd targets escaping the workspace for L2 shell execution', async () => {
    const result = await exec('cd .. && pwd', {
      enforceWorkspaceBoundary: true,
      permissionLevel: 'L2_SHELL_EXEC',
    });

    expect(result.blocked).toBe(true);
    expect(result.stderr).toContain('Shell is restricted to the workspace');
  });

  it('allows configured additional roots for L2 shell execution', async () => {
    hoisted.additionalAllowedRoots = [outsideDir];

    const result = await exec('pwd', {
      cwd: outsideDir,
      enforceWorkspaceBoundary: true,
      permissionLevel: 'L2_SHELL_EXEC',
    });

    expect(result.blocked).toBe(false);
    expect(realpathSync(result.stdout.trim())).toBe(realpathSync(outsideDir));
  });

  it('lets L3 bypass the workspace path guard', async () => {
    const result = await exec('pwd', {
      cwd: outsideDir,
      enforceWorkspaceBoundary: true,
      permissionLevel: 'L3_FULL_ACCESS',
    });

    expect(result.blocked).toBe(false);
    expect(realpathSync(result.stdout.trim())).toBe(realpathSync(outsideDir));
  });
});
