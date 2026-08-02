import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, removeTempDir } from '../test-helpers.js';
import {
  formatRuntimeSkillsCommandOutput,
  getRuntimeSkillDetail,
  installWorkspaceSkill,
  listRuntimeSkills,
  promoteAutogenSkill,
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

  /**
   * A user handing over "the skill I made" hands over an archive, not a
   * directory — `.skill` is what this repo's own packager emits. Installing it
   * must not require the operator to unpack anything first.
   */
  it('installs a skill straight from a .zip package', async () => {
    const stageDir = createTempDir();
    const archiveDir = createTempDir();
    const localWorkspaceDir = createTempDir();
    try {
      const packagedSkillDir = join(stageDir, 'packaged-skill');
      mkdirSync(packagedSkillDir, { recursive: true });
      writeFileSync(join(packagedSkillDir, 'SKILL.md'), `---
name: Packaged Skill
description: Installed from an archive
---

Run the packaged workflow.
`);
      const archivePath = join(archiveDir, 'packaged-skill.zip');
      execFileSync('zip', ['-q', '-r', archivePath, 'packaged-skill'], { cwd: stageDir, stdio: 'pipe' });

      const result = await installWorkspaceSkill({
        source: 'path',
        source_path: archivePath,
        bundledDir,
        workspaceDir: localWorkspaceDir,
      });

      expect(result.installed.name).toBe('Packaged Skill');
      expect(result.installed.source).toBe('workspace');
      expect(result.installed.eligible).toBe(true);
      // The installed copy must survive the temp-dir cleanup that runs in the
      // installer's `finally`.
      expect(existsSync(join(localWorkspaceDir, 'packaged-skill', 'SKILL.md'))).toBe(true);
    } finally {
      removeTempDir(stageDir);
      removeTempDir(archiveDir);
      removeTempDir(localWorkspaceDir);
    }
  });

  it('rejects a non-archive file as a skill source', async () => {
    const stageDir = createTempDir();
    try {
      const notASkill = join(stageDir, 'holdings.xlsx');
      writeFileSync(notASkill, 'not a skill');
      await expect(installWorkspaceSkill({
        source: 'path',
        source_path: notASkill,
        bundledDir,
        workspaceDir,
      })).rejects.toThrow(/Not a skill source/);
    } finally {
      removeTempDir(stageDir);
    }
  });

  /**
   * `propose_skill` writes drafts that `listRuntimeSkills` hides "until an
   * operator has reviewed and promoted them" — and until now no promotion path
   * existed anywhere in the codebase, so a draft could only stay a draft.
   */
  describe('promoting an autogen draft', () => {
    const draftContent = `---
name: autogen-weekly-brief
description: Drafted by MOZI mid-task
version: 0.1.0
category: utility
user-invocable: false
origin: autogen
metadata:
  sandbox_profile: read-only
---

# Weekly brief

1. Read the ledger.
`;

    it('flips user-invocable, drops the autogen origin, and keeps the body', async () => {
      const localWorkspaceDir = createTempDir();
      try {
        const draftDir = join(localWorkspaceDir, 'autogen-weekly-brief');
        mkdirSync(draftDir, { recursive: true });
        writeFileSync(join(draftDir, 'SKILL.md'), draftContent);

        const hiddenByDefault = await listRuntimeSkills({ bundledDir, workspaceDir: localWorkspaceDir });
        expect(hiddenByDefault.some((skill) => skill.name === 'autogen-weekly-brief')).toBe(false);

        const promoted = await promoteAutogenSkill('workspace:autogen-weekly-brief', {
          bundledDir,
          workspaceDir: localWorkspaceDir,
        });

        expect(promoted.user_invocable).toBe(true);
        expect(promoted.origin).toBeUndefined();
        expect(promoted.content).toContain('# Weekly brief');
        expect(promoted.content).toContain('1. Read the ledger.');
        // Untouched frontmatter survives the rewrite.
        expect(promoted.frontmatter.metadata?.sandbox_profile).toBe('read-only');

        const listed = await listRuntimeSkills({ bundledDir, workspaceDir: localWorkspaceDir });
        expect(listed.some((skill) => skill.name === 'autogen-weekly-brief')).toBe(true);
      } finally {
        removeTempDir(localWorkspaceDir);
      }
    });

    it('refuses to promote a skill that is not a draft', async () => {
      await expect(promoteAutogenSkill('workspace:skill-b', { bundledDir, workspaceDir }))
        .rejects.toThrow(/Only autogen drafts/);
    });

    it('refuses to promote a bundled skill', async () => {
      await expect(promoteAutogenSkill('bundled:skill-a', { bundledDir, workspaceDir }))
        .rejects.toThrow(/read-only/);
    });
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
