import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, removeTempDir } from '../test-helpers.js';

const hoisted = vi.hoisted(() => ({
  runtimeRoot: '',
  workspaceDir: '',
  provision: vi.fn(),
}));

vi.mock('../runtime/project-root.js', () => ({
  getRuntimeProjectRoot: () => hoisted.runtimeRoot,
}));

vi.mock('../tools/workspace-policy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tools/workspace-policy.js')>();
  return { ...actual, getWorkspaceDir: () => hoisted.workspaceDir };
});

vi.mock('./provision-deps.js', () => ({
  provisionSkillDependencies: hoisted.provision,
}));

import { clearActiveSkillsForTests, getActiveSkills, activeSkillScope } from './active-skills.js';
import { clearSkillDiscoveryCache } from './loader.js';
import { extractDependencyFailure, recoverDeclaredSkillDependency } from './dependency-ledger.js';

function writeSkill(dirName: string, body: string): void {
  const dir = join(hoisted.runtimeRoot, 'skills', dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), body, 'utf8');
}

const context = { tenantId: 'ledger', sessionId: 'session', chatId: 'chat' };

describe('skill dependency ledger', () => {
  beforeEach(() => {
    hoisted.runtimeRoot = createTempDir();
    hoisted.workspaceDir = createTempDir();
    mkdirSync(join(hoisted.runtimeRoot, 'skills'), { recursive: true });
    mkdirSync(join(hoisted.workspaceDir, 'skills'), { recursive: true });
    hoisted.provision.mockReset();
    hoisted.provision.mockResolvedValue({ installed: ['matplotlib'], ready: [], needsAction: [], failed: [] });
    clearSkillDiscoveryCache();
    clearActiveSkillsForTests();
  });

  afterEach(() => {
    clearSkillDiscoveryCache();
    clearActiveSkillsForTests();
    removeTempDir(hoisted.runtimeRoot);
    removeTempDir(hoisted.workspaceDir);
  });

  it('extracts exact Python, Node, binary, and env failures', () => {
    expect(extractDependencyFailure("ModuleNotFoundError: No module named 'matplotlib.pyplot'")).toEqual({ kind: 'python', name: 'matplotlib' });
    expect(extractDependencyFailure("Error: Cannot find module 'pptxgenjs'")).toEqual({ kind: 'npm', name: 'pptxgenjs' });
    expect(extractDependencyFailure("Error: Cannot find module '@scope/chart-kit'")).toEqual({ kind: 'npm', name: '@scope/chart-kit' });
    expect(extractDependencyFailure('zsh:1: command not found: soffice')).toEqual({ kind: 'binary', name: 'soffice' });
    expect(extractDependencyFailure('Environment variable OPENAI_API_KEY is not set')).toEqual({ kind: 'env', name: 'OPENAI_API_KEY' });
  });

  it('provisions an exact declared import and activates its skill for the retry', async () => {
    writeSkill('data-analysis', `---
name: data-analysis
description: Analyze data and generate charts
install:
  - kind: pip
    package: matplotlib
    imports: [matplotlib]
---

Use matplotlib through the managed runtime.
`);

    const recovery = await recoverDeclaredSkillDependency("ModuleNotFoundError: No module named 'matplotlib'", context);

    expect(recovery).toMatchObject({ status: 'provisioned', skill: { name: 'data-analysis' } });
    expect(hoisted.provision).toHaveBeenCalledWith([
      expect.objectContaining({ kind: 'pip', package: 'matplotlib', imports: ['matplotlib'] }),
    ]);
    const scope = activeSkillScope(context)!;
    expect(getActiveSkills(scope).map(skill => skill.name)).toEqual(['data-analysis']);
  });

  it('never guesses or installs an undeclared package', async () => {
    writeSkill('data-analysis', `---
name: data-analysis
description: Analyze data
install:
  - kind: pip
    package: matplotlib
    imports: [matplotlib]
---

Body.
`);

    expect(await recoverDeclaredSkillDependency("ModuleNotFoundError: No module named 'totally_unknown'", context)).toBeNull();
    expect(hoisted.provision).not.toHaveBeenCalled();
  });

  it('surfaces system dependencies as explicit actions without auto-running brew', async () => {
    writeSkill('xlsx', `---
name: xlsx
description: Spreadsheet workflow
install:
  - kind: brew
    formula: libreoffice
    bins: [soffice]
---

Body.
`);

    const recovery = await recoverDeclaredSkillDependency('zsh:1: command not found: soffice', context);

    expect(recovery).toMatchObject({ status: 'needs_action' });
    expect(recovery?.message).toContain('brew install libreoffice');
    expect(hoisted.provision).not.toHaveBeenCalled();
  });

  it('does not guess when different manifests claim the same import', async () => {
    for (const [name, pkg] of [['one', 'package-one'], ['two', 'package-two']]) {
      writeSkill(name, `---
name: ${name}
description: ${name}
install:
  - kind: pip
    package: ${pkg}
    imports: [shared_import]
---

Body.
`);
    }

    const recovery = await recoverDeclaredSkillDependency("ModuleNotFoundError: No module named 'shared_import'", context);

    expect(recovery).toMatchObject({ status: 'ambiguous' });
    expect(hoisted.provision).not.toHaveBeenCalled();
  });
});
