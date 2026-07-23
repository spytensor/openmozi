import { describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  listRuntimeSkillsMock: vi.fn(),
  formatRuntimeSkillsCommandOutputMock: vi.fn(),
  installWorkspaceSkillMock: vi.fn(),
  setWorkspaceSkillStateMock: vi.fn(),
  validateRuntimeSkillMock: vi.fn(),
}));

vi.mock('../skills/workspace-manager.js', () => ({
  listRuntimeSkills: hoisted.listRuntimeSkillsMock,
  formatRuntimeSkillsCommandOutput: hoisted.formatRuntimeSkillsCommandOutputMock,
  installWorkspaceSkill: hoisted.installWorkspaceSkillMock,
  setWorkspaceSkillState: hoisted.setWorkspaceSkillStateMock,
  validateRuntimeSkill: hoisted.validateRuntimeSkillMock,
}));

import { executeSystemTool, SYSTEM_TOOLS } from './system-tools.js';

describe('tools/system-tools skill runtime', () => {
  it('registers skill runtime tools', () => {
    const names = SYSTEM_TOOLS.map((tool) => tool.function.name);
    expect(names).toContain('use_skill');
    expect(names).toContain('list_runtime_skills');
    expect(names).toContain('install_skill');
    expect(names).toContain('set_skill_state');
    expect(names).toContain('validate_skill');
  });

  it('lists runtime skills through the manager', async () => {
    hoisted.listRuntimeSkillsMock.mockResolvedValueOnce([{ name: 'Skill A' }]);
    hoisted.formatRuntimeSkillsCommandOutputMock.mockReturnValueOnce('formatted skills');

    const result = await executeSystemTool('list_runtime_skills', {}, 'call-list-skills');
    expect(result?.is_error).toBe(false);
    expect(result?.content).toBe('formatted skills');
  });

  it('installs a skill from a local path', async () => {
    hoisted.installWorkspaceSkillMock.mockResolvedValueOnce({ installed: { name: 'Skill A' }, overwritten: false });

    const result = await executeSystemTool(
      'install_skill',
      { source: 'path', source_path: '/tmp/skill-a' },
      'call-install-skill',
    );

    expect(result?.is_error).toBe(false);
    expect(hoisted.installWorkspaceSkillMock).toHaveBeenCalledWith(expect.objectContaining({
      source: 'path',
      source_path: '/tmp/skill-a',
    }));
  });

  it('passes git install arguments through', async () => {
    hoisted.installWorkspaceSkillMock.mockResolvedValueOnce({ installed: { name: 'Remote Skill' }, overwritten: false });

    const result = await executeSystemTool(
      'install_skill',
      { source: 'git', repo_url: 'https://example.com/skills.git', skill_subpath: 'pack' },
      'call-install-git-skill',
    );

    expect(result?.is_error).toBe(false);
    expect(hoisted.installWorkspaceSkillMock).toHaveBeenCalledWith(expect.objectContaining({
      source: 'git',
      repo_url: 'https://example.com/skills.git',
      skill_subpath: 'pack',
    }));
  });

  it('toggles workspace skill state', async () => {
    hoisted.setWorkspaceSkillStateMock.mockResolvedValueOnce({ name: 'Skill A', enabled: false });

    const result = await executeSystemTool(
      'set_skill_state',
      { skill_id: 'skill-a', enabled: false },
      'call-set-skill-state',
    );

    expect(result?.is_error).toBe(false);
    expect(hoisted.setWorkspaceSkillStateMock).toHaveBeenCalledWith('skill-a', false);
  });

  it('validates a runtime skill', async () => {
    hoisted.validateRuntimeSkillMock.mockResolvedValueOnce({ name: 'Skill A', eligible: true });

    const result = await executeSystemTool(
      'validate_skill',
      { skill_id: 'skill-a', source: 'bundled' },
      'call-validate-skill',
    );

    expect(result?.is_error).toBe(false);
    expect(hoisted.validateRuntimeSkillMock).toHaveBeenCalledWith('skill-a', { source: 'bundled' });
  });
});
