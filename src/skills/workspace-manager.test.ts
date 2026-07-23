import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, removeTempDir } from '../test-helpers.js';
import {
  formatRuntimeSkillsCommandOutput,
  getRuntimeSkillDetail,
  installWorkspaceSkill,
  listRuntimeSkills,
  setWorkspaceSkillState,
  updateWorkspaceSkillContent,
  validateRuntimeSkill,
} from './workspace-manager.js';

let bundledDir: string;
let workspaceDir: string;

beforeAll(() => {
  bundledDir = createTempDir();
  workspaceDir = createTempDir();

  const bundledSkillDir = join(bundledDir, 'skill-a');
  mkdirSync(bundledSkillDir, { recursive: true });
  writeFileSync(join(bundledSkillDir, 'SKILL.md'), `---
name: Skill A
description: Bundled skill A
requires:
  env: [A_KEY]
---

Use skill A.
`);

  const workspaceSkillDir = join(workspaceDir, 'skill-b');
  mkdirSync(workspaceSkillDir, { recursive: true });
  writeFileSync(join(workspaceSkillDir, 'SKILL.md'), `---
name: Skill B
description: Workspace skill B
---

Use skill B.
`);
});

afterAll(() => {
  removeTempDir(bundledDir);
  removeTempDir(workspaceDir);
});

describe('skills/workspace-manager', () => {
  it('lists runtime skills with state and eligibility', async () => {
    const skills = await listRuntimeSkills({ bundledDir, workspaceDir });
    expect(skills).toHaveLength(2);
    expect(skills.some((skill) => skill.name === 'Skill A' && skill.eligible === false)).toBe(true);
    expect(skills.some((skill) => skill.name === 'Skill B' && skill.enabled === true && skill.eligible === true)).toBe(true);
  });

  it('installs a bundled skill into workspace', async () => {
    process.env.A_KEY = 'present';
    const result = await installWorkspaceSkill({
      source: 'bundled',
      skill_id: 'skill-a',
      target_name: 'installed-skill-a',
      bundledDir,
      workspaceDir,
    });

    expect(result.installed.source).toBe('workspace');
    expect(result.installed.directory_name).toBe('installed-skill-a');
    expect(result.installed.enabled).toBe(true);
    expect(result.installed.eligible).toBe(true);
    delete process.env.A_KEY;
  });

  it('can disable and re-enable a workspace skill', async () => {
    const disabled = await setWorkspaceSkillState('skill-b', false, { bundledDir, workspaceDir });
    expect(disabled.enabled).toBe(false);
    expect(disabled.eligible).toBe(false);

    const enabled = await setWorkspaceSkillState('skill-b', true, { bundledDir, workspaceDir });
    expect(enabled.enabled).toBe(true);
    expect(enabled.eligible).toBe(true);
  });

  it('validates a specific runtime skill', async () => {
    const result = await validateRuntimeSkill('skill-a', {
      source: 'bundled',
      bundledDir,
      workspaceDir,
    });

    expect(result.name).toBe('Skill A');
    expect(result.missing_env).toEqual(['A_KEY']);
  });

  it('can resolve bundled skills by frontmatter name', async () => {
    const result = await validateRuntimeSkill('Skill A', {
      source: 'bundled',
      bundledDir,
      workspaceDir,
    });
    expect(result.directory_name).toBe('skill-a');
  });

  it('reads skill detail with raw content and file sizes', async () => {
    const detail = await getRuntimeSkillDetail('bundled:Skill A', { bundledDir, workspaceDir });
    expect(detail.source).toBe('bundled');
    expect(detail.directory_name).toBe('skill-a');
    expect(detail.frontmatter.name).toBe('Skill A');
    expect(detail.content).toContain('Use skill A.');
    expect(detail.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'SKILL.md', size: expect.any(Number) }),
      ]),
    );
  });

  it('updates workspace SKILL.md content after validation', async () => {
    const localWorkspaceDir = createTempDir();
    try {
      const skillDir = join(localWorkspaceDir, 'editable-skill');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), `---
name: editable-skill
description: Editable skill
---

Old body.
`);

      const updatedContent = `---
name: editable-skill
description: Updated editable skill
version: "1.0.0"
category: utility
user-invocable: true
---

New body.
`;

      const updated = await updateWorkspaceSkillContent('workspace:editable-skill', updatedContent, {
        bundledDir,
        workspaceDir: localWorkspaceDir,
      });

      expect(updated.description).toBe('Updated editable skill');
      expect(updated.content).toBe(updatedContent);
      expect(updated.files.some(file => file.name === 'SKILL.md' && file.size === Buffer.byteLength(updatedContent))).toBe(true);

      await expect(updateWorkspaceSkillContent('workspace:editable-skill', 'not frontmatter', {
        bundledDir,
        workspaceDir: localWorkspaceDir,
      })).rejects.toThrow('missing YAML frontmatter');
    } finally {
      removeTempDir(localWorkspaceDir);
    }
  });

  it('formats runtime skill output', async () => {
    const output = formatRuntimeSkillsCommandOutput(await listRuntimeSkills({ bundledDir, workspaceDir }));
    expect(output).toContain('Skills —');
    expect(output).toContain('Skill B');
    expect(output).toContain('source=workspace');
  });
});
