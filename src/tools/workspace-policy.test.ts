import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config/index.js';
import {
  ensureToolWorkspaceDir,
  getOutputDir,
  getWorkspaceAllowedRoots,
  getWorkspaceDir,
} from './workspace-policy.js';
import { executeFsTool } from './fs-tools.js';

describe('tools/workspace-policy default roots', () => {
  const savedMoziHome = process.env.MOZI_HOME;
  const savedMoziWorkspaces = process.env.MOZI_WORKSPACES;
  let moziHome: string;

  beforeEach(() => {
    moziHome = mkdtempSync(join(tmpdir(), 'mozi-policy-home-'));
    process.env.MOZI_HOME = moziHome;
    delete process.env.MOZI_WORKSPACES;
    loadConfig('/nonexistent/mozi.json');
  });

  afterEach(() => {
    rmSync(moziHome, { recursive: true, force: true });
    if (savedMoziHome === undefined) {
      delete process.env.MOZI_HOME;
    } else {
      process.env.MOZI_HOME = savedMoziHome;
    }
    if (savedMoziWorkspaces === undefined) {
      delete process.env.MOZI_WORKSPACES;
    } else {
      process.env.MOZI_WORKSPACES = savedMoziWorkspaces;
    }
    loadConfig('/nonexistent/mozi.json');
  });

  it('auto-creates output and workspace and always includes both allowed roots', () => {
    const outputDir = join(moziHome, 'output');
    const workspaceDir = join(moziHome, 'workspace');

    expect(getOutputDir()).toBe(outputDir);
    expect(getWorkspaceDir()).toBe(workspaceDir);
    expect(existsSync(outputDir)).toBe(true);
    expect(existsSync(workspaceDir)).toBe(true);
    expect(getWorkspaceAllowedRoots()).toEqual([outputDir, workspaceDir]);
  });

  it('maps default single-user ids to the legacy workspace directory', () => {
    const workspaceDir = join(moziHome, 'workspace');

    expect(getWorkspaceDir()).toBe(workspaceDir);
    expect(getWorkspaceDir('')).toBe(workspaceDir);
    expect(getWorkspaceDir('default')).toBe(workspaceDir);
    expect(getWorkspaceDir('local-user')).toBe(workspaceDir);
  });

  it('builds per-user allowed roots without exposing sibling user workspaces', async () => {
    const outputDir = join(moziHome, 'output');
    const userADir = join(moziHome, 'workspace', 'users', 'user-a');
    const userBDir = join(moziHome, 'workspace', 'users', 'user-b');

    await ensureToolWorkspaceDir('user-a');
    await ensureToolWorkspaceDir('user-b');

    expect(getWorkspaceDir('user-a')).toBe(userADir);
    expect(getWorkspaceAllowedRoots('user-a')).toEqual([outputDir, userADir]);
    expect(getWorkspaceAllowedRoots('user-a')).not.toContain(userBDir);
  });

  it('blocks fs tool reads from another user workspace', async () => {
    const userBDir = await ensureToolWorkspaceDir('user-b');
    const userBFile = join(userBDir, 'secret.txt');
    writeFileSync(userBFile, 'user-b-secret');

    await ensureToolWorkspaceDir('user-a');

    await expect(executeFsTool(
      'read_file',
      { path: userBFile },
      'call-read-other-user',
      { userId: 'user-a' },
    )).rejects.toThrow('workspace_only policy');
  });
});
