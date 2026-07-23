import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config/index.js';
import { ensureToolWorkspaceDir } from './workspace-policy.js';
import { executeShellTool } from './shell-tools.js';

describe('tools/shell-tools workspace boundary', () => {
  const savedMoziHome = process.env.MOZI_HOME;
  const savedMoziWorkspaces = process.env.MOZI_WORKSPACES;
  let moziHome: string;

  beforeEach(() => {
    moziHome = mkdtempSync(join(tmpdir(), 'mozi-shell-tools-home-'));
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

  it('blocks user A shell access to user B workspace files', async () => {
    const userBDir = await ensureToolWorkspaceDir('user-b');
    const userBFile = join(userBDir, 'secret.txt');
    writeFileSync(userBFile, 'user-b-secret');

    const result = await executeShellTool(
      'shell_exec',
      { command: `cat ${JSON.stringify(userBFile)}` },
      'call-shell-other-user',
      {
        userId: 'user-a',
        agentId: 'agent-l2',
        permissionLevel: 'L2_SHELL_EXEC',
        tenantId: 'tenant-shell-tools',
      },
    );

    expect(result?.is_error).toBe(true);
    expect(result?.content).toContain('Shell is restricted to the workspace');
  });

  it('blocks default shell access outside the workspace whitelist', async () => {
    const result = await executeShellTool(
      'shell_exec',
      { command: 'cat ~/.ssh/id_rsa' },
      'call-shell-ssh',
      {
        userId: 'default',
        agentId: 'agent-l2',
        permissionLevel: 'L2_SHELL_EXEC',
        tenantId: 'tenant-shell-tools',
      },
    );

    expect(result?.is_error).toBe(true);
    expect(result?.content).toContain('Shell is restricted to the workspace');
  });
});
