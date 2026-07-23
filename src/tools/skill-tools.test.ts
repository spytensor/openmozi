import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, removeTempDir } from '../test-helpers.js';

const hoisted = vi.hoisted(() => ({
  runtimeRoot: '',
  workspaceDir: '',
}));

vi.mock('../runtime/project-root.js', () => ({
  getRuntimeProjectRoot: () => hoisted.runtimeRoot,
}));

vi.mock('./tool-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tool-utils.js')>();
  return {
    ...actual,
    getWorkspaceDir: () => hoisted.workspaceDir,
  };
});

import { clearSkillDiscoveryCache, discoverSkills } from '../skills/loader.js';
import {
  activeSkillScope,
  clearActiveSkillsForTests,
  getActiveSkills,
} from '../skills/active-skills.js';
import { extractToolIntent, extractToolSkillName } from './executor.js';
import { executeSkillTool, SKILL_TOOL_DEFINITIONS } from './skill-tools.js';
import { SYSTEM_TOOLS } from './system-tools.js';

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function writeSkill(baseDir: string, dirName: string, content: string): void {
  const skillDir = join(baseDir, dirName);
  ensureDir(skillDir);
  writeFileSync(join(skillDir, 'SKILL.md'), content, 'utf-8');
}

const toolContext = {
  tenantId: 'skill-tools-test',
  sessionId: 'skill-tools-session',
  chatId: 'skill-tools-chat',
};

describe('tools/skill-tools', () => {
  beforeEach(() => {
    hoisted.runtimeRoot = createTempDir();
    hoisted.workspaceDir = createTempDir();
    ensureDir(join(hoisted.runtimeRoot, 'skills'));
    ensureDir(join(hoisted.workspaceDir, 'skills'));
    clearSkillDiscoveryCache();
    clearActiveSkillsForTests();
  });

  afterEach(() => {
    clearSkillDiscoveryCache();
    clearActiveSkillsForTests();
    removeTempDir(hoisted.runtimeRoot);
    removeTempDir(hoisted.workspaceDir);
  });

  it('registers skill lifecycle tools in skill and system tool registries', () => {
    expect(SKILL_TOOL_DEFINITIONS.map(tool => tool.function.name)).toContain('use_skill');
    expect(SKILL_TOOL_DEFINITIONS.map(tool => tool.function.name)).toContain('unload_skill');
    expect(SYSTEM_TOOLS.map(tool => tool.function.name)).toContain('use_skill');
    expect(SYSTEM_TOOLS.map(tool => tool.function.name)).toContain('unload_skill');
  });

  it('returns a short ack and stores full instructions in the active registry', async () => {
    writeSkill(join(hoisted.runtimeRoot, 'skills'), 'demo', `---
name: demo-skill
description: Demo skill
---

# Demo Skill

Use the demo procedure.
`);

    const result = await executeSkillTool('use_skill', { name: 'demo-skill' }, 'call-use-skill', toolContext);

    expect(result?.is_error).toBe(false);
    expect(result?.tool_name).toBe('use_skill');
    expect(result).toMatchObject({
      skillName: 'demo-skill',
      skillDescription: 'Demo skill',
      skillLoadOutcome: 'success',
    });
    expect(result?.content).toBe('Skill demo-skill loaded — full instructions are available in the Active Skills section of your context.');
    expect(result?.content).not.toContain('# Demo Skill');
    expect(result?.content).not.toContain('Use the demo procedure.');
    expect(result?.content).not.toContain('name: demo-skill');
    expect(result?.content).not.toContain('---');

    const scope = activeSkillScope(toolContext);
    expect(scope).toBeTruthy();
    const active = getActiveSkills(scope!);
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      name: 'demo-skill',
      description: 'Demo skill',
      instructions: '# Demo Skill\n\nUse the demo procedure.',
    });
  });

  it('does not duplicate active registry entries when a skill is loaded twice', async () => {
    writeSkill(join(hoisted.runtimeRoot, 'skills'), 'demo', `---
name: demo-skill
description: Demo skill
---

# Demo Skill

Use the demo procedure.
`);

    await executeSkillTool('use_skill', { name: 'demo-skill' }, 'call-use-skill-1', toolContext);
    await executeSkillTool('use_skill', { name: 'demo-skill' }, 'call-use-skill-2', toolContext);

    const scope = activeSkillScope(toolContext);
    expect(getActiveSkills(scope!)).toHaveLength(1);
  });

  it('reports brew/manual dependencies as operator actions, never as ready', async () => {
    writeSkill(join(hoisted.runtimeRoot, 'skills'), 'system-dep', `---
name: system-dep
description: Needs a system binary
install:
  - kind: brew
    formula: mozi-test-missing-formula
    bins: [__mozi_test_missing_binary__]
---

Use the system dependency.
`);

    const result = await executeSkillTool('use_skill', { name: 'system-dep' }, 'call-system-dep', toolContext);

    expect(result?.is_error).toBe(false);
    expect(result?.content).toContain('Runtime dependencies requiring explicit operator action');
    expect(result?.content).toContain('brew install mozi-test-missing-formula');
    expect(result?.content).not.toContain('verified ready');
  });

  it('unload_skill removes an active skill from the registry', async () => {
    writeSkill(join(hoisted.runtimeRoot, 'skills'), 'demo', `---
name: demo-skill
description: Demo skill
---

# Demo Skill
`);

    await executeSkillTool('use_skill', { name: 'demo-skill' }, 'call-use-skill', toolContext);
    const unloaded = await executeSkillTool('unload_skill', { name: 'demo-skill' }, 'call-unload-skill', toolContext);

    expect(unloaded?.is_error).toBe(false);
    expect(unloaded?.content).toBe('Skill demo-skill unloaded.');
    const scope = activeSkillScope(toolContext);
    expect(getActiveSkills(scope!)).toHaveLength(0);
  });

  it('returns an error for an unknown skill name', async () => {
    const result = await executeSkillTool('use_skill', { name: 'missing-skill' }, 'call-missing-skill', toolContext);

    expect(result?.is_error).toBe(true);
    expect(result).toMatchObject({
      skillName: 'missing-skill',
      skillLoadOutcome: 'not_found',
      skillLoadError: 'Skill not found',
    });
    expect(result?.content).toContain('Unknown or ineligible skill "missing-skill"');
    expect(result?.content).toContain('Available Skills catalog');
  });

  it('returns an error with the catalog line for a known but ineligible skill', async () => {
    writeSkill(join(hoisted.runtimeRoot, 'skills'), 'gated', `---
name: gated-skill
description: Gated skill
requires:
  env: [__MOZI_USE_SKILL_TEST_MISSING_ENV__]
---

# Gated Skill
`);

    const result = await executeSkillTool('use_skill', { name: 'gated-skill' }, 'call-gated-skill', toolContext);

    expect(result?.is_error).toBe(true);
    expect(result).toMatchObject({
      skillName: 'gated-skill',
      skillDescription: 'Gated skill',
      skillLoadOutcome: 'ineligible',
      skillMissingEnv: ['__MOZI_USE_SKILL_TEST_MISSING_ENV__'],
    });
    expect(result?.content).toContain('Unknown or ineligible skill "gated-skill"');
    expect(result?.content).toContain('Catalog line: - gated-skill: Gated skill');
  });

  it('invalidates the discovery cache when reload_skills runs', async () => {
    const bundledDir = join(hoisted.runtimeRoot, 'skills');
    const workspaceSkillsDir = join(hoisted.workspaceDir, 'skills');
    writeSkill(bundledDir, 'cached', `---
name: cached-skill
description: version one
---

Body v1.
`);

    const first = await discoverSkills({ bundledDir, workspaceDir: workspaceSkillsDir });
    expect(first.find(skill => skill.name === 'cached-skill')?.description).toBe('version one');

    writeSkill(bundledDir, 'cached', `---
name: cached-skill
description: version two
---

Body v2.
`);

    const cached = await discoverSkills({ bundledDir, workspaceDir: workspaceSkillsDir });
    expect(cached.find(skill => skill.name === 'cached-skill')?.description).toBe('version one');

    const reload = await executeSkillTool('reload_skills', {}, 'call-reload-skills');
    expect(reload?.is_error).toBe(false);

    const refreshed = await discoverSkills({ bundledDir, workspaceDir: workspaceSkillsDir });
    expect(refreshed.find(skill => skill.name === 'cached-skill')?.description).toBe('version two');
  });

  it('extracts use_skill progress intent and skill attribution', () => {
    const argsJson = JSON.stringify({ name: 'demo-skill' });
    expect(extractToolIntent('use_skill', argsJson)).toBe('Load skill demo-skill');
    expect(extractToolSkillName('use_skill', argsJson)).toBe('demo-skill');
    expect(extractToolSkillName('read_file', JSON.stringify({ path: 'x' }))).toBeUndefined();
  });
});
