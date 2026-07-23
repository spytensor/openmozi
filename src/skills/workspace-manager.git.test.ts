import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, removeTempDir } from '../test-helpers.js';

const hoisted = vi.hoisted(() => ({
  execFileSyncMock: vi.fn((command: string, args: string[]) => {
    if (command !== 'git') throw new Error(`unexpected command: ${command}`);
    const checkoutDir = args[args.length - 1]!;
    const skillDir = join(checkoutDir, 'skills', 'remote-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), `---
name: Remote Skill
description: Installed from git
---

Use remote skill.
`);
    return '';
  }),
}));

vi.mock('node:child_process', () => ({
  execFileSync: hoisted.execFileSyncMock,
}));

import { installWorkspaceSkill } from './workspace-manager.js';

let bundledDir: string;
let workspaceDir: string;

beforeAll(() => {
  bundledDir = createTempDir();
  workspaceDir = createTempDir();
});

afterAll(() => {
  removeTempDir(bundledDir);
  removeTempDir(workspaceDir);
});

describe('skills/workspace-manager git install', () => {
  it('installs a skill from an https git repository', async () => {
    const result = await installWorkspaceSkill({
      source: 'git',
      repo_url: 'https://example.com/skills.git',
      skill_subpath: 'skills/remote-skill',
      target_name: 'remote-installed',
      bundledDir,
      workspaceDir,
    });

    expect(result.installed.name).toBe('Remote Skill');
    expect(result.installed.directory_name).toBe('remote-installed');
    expect(hoisted.execFileSyncMock).toHaveBeenCalledWith(
      'git',
      ['clone', '--depth', '1', 'https://example.com/skills.git', expect.any(String)],
      expect.objectContaining({ timeout: 30_000 }),
    );
  });

  it('rejects non-https skill repos', async () => {
    await expect(installWorkspaceSkill({
      source: 'git',
      repo_url: 'ssh://example.com/private.git',
      bundledDir,
      workspaceDir,
    })).rejects.toThrow('Skill repo URL must use https');
  });
});
