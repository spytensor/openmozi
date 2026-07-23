import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseSkillFile,
  checkRequirements,
  clearSkillDiscoveryCache,
  formatSkillsForPrompt,
  discoverSkills,
  type LoadedSkill,
  type SkillFrontmatter,
} from './loader.js';
import { createTempDir, removeTempDir } from '../test-helpers.js';

const PROJECT_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const BUNDLED_SKILLS_DIR = join(PROJECT_ROOT, 'skills');

// ---------------------------------------------------------------------------
// parseSkillFile
// ---------------------------------------------------------------------------

describe('parseSkillFile', () => {
  it('parses valid SKILL.md with all fields', () => {
    const content = `---
name: coding-agent
description: Delegate coding tasks to external AI coding agents
license: Complete terms in LICENSE.txt
user-invocable: true
always: false
requires:
  anyBins: [claude, codex]
  env: [ANTHROPIC_API_KEY]
install:
  - kind: brew
    formula: claude-code
    bins: [claude]
    label: "Install Claude Code via Homebrew"
---

# Coding Agent

Markdown instructions for the LLM.`;

    const result = parseSkillFile(content);

    expect(result.frontmatter.name).toBe('coding-agent');
    expect(result.frontmatter.description).toBe('Delegate coding tasks to external AI coding agents');
    expect(result.frontmatter.license).toBe('Complete terms in LICENSE.txt');
    expect(result.frontmatter['user-invocable']).toBe(true);
    expect(result.frontmatter.always).toBe(false);
    expect(result.frontmatter.requires?.anyBins).toEqual(['claude', 'codex']);
    expect(result.frontmatter.requires?.env).toEqual(['ANTHROPIC_API_KEY']);
    expect(result.frontmatter.install).toHaveLength(1);
    expect(result.frontmatter.install![0].kind).toBe('brew');
    expect(result.frontmatter.install![0].formula).toBe('claude-code');
    expect(result.frontmatter.install![0].bins).toEqual(['claude']);
    expect(result.instructions).toBe('# Coding Agent\n\nMarkdown instructions for the LLM.');
  });

  it('parses minimal SKILL.md with only required fields', () => {
    const content = `---
name: simple
description: A simple skill
---

Instructions here.`;

    const result = parseSkillFile(content);
    expect(result.frontmatter.name).toBe('simple');
    expect(result.frontmatter.description).toBe('A simple skill');
    expect(result.frontmatter.requires).toBeUndefined();
    expect(result.frontmatter.install).toBeUndefined();
    expect(result.instructions).toBe('Instructions here.');
  });

  it('throws on missing frontmatter delimiters', () => {
    expect(() => parseSkillFile('no frontmatter here')).toThrow('missing YAML frontmatter');
  });

  it('throws on missing name field', () => {
    const content = `---
description: has no name
---

Body.`;
    expect(() => parseSkillFile(content)).toThrow('missing required field: name');
  });

  it('throws on missing description field', () => {
    const content = `---
name: no-desc
---

Body.`;
    expect(() => parseSkillFile(content)).toThrow('missing required field: description');
  });

  it('handles bins requirement', () => {
    const content = `---
name: test
description: test skill
requires:
  bins: [node, git]
---

Body.`;

    const result = parseSkillFile(content);
    expect(result.frontmatter.requires?.bins).toEqual(['node', 'git']);
  });
});

// ---------------------------------------------------------------------------
// checkRequirements
// ---------------------------------------------------------------------------

describe('checkRequirements', () => {
  it('returns eligible when no requirements specified', async () => {
    const result = await checkRequirements(undefined);
    expect(result.eligible).toBe(true);
    expect(result.missingBins).toBeUndefined();
    expect(result.missingEnv).toBeUndefined();
  });

  it('returns eligible when bins exist (node is always available)', async () => {
    const result = await checkRequirements({ bins: ['node'] });
    expect(result.eligible).toBe(true);
  });

  it('returns ineligible when bins do not exist', async () => {
    const result = await checkRequirements({ bins: ['__nonexistent_binary_xyz__'] });
    expect(result.eligible).toBe(false);
    expect(result.missingBins).toContain('__nonexistent_binary_xyz__');
  });

  it('returns eligible when anyBins has at least one match', async () => {
    const result = await checkRequirements({
      anyBins: ['__nonexistent__', 'node'],
    });
    expect(result.eligible).toBe(true);
  });

  it('returns ineligible when no anyBins match', async () => {
    const result = await checkRequirements({
      anyBins: ['__nonexistent_a__', '__nonexistent_b__'],
    });
    expect(result.eligible).toBe(false);
    expect(result.missingBins).toBeDefined();
  });

  it('checks env vars from process.env', async () => {
    // PATH is always set
    const result = await checkRequirements({ env: ['PATH'] });
    expect(result.eligible).toBe(true);
  });

  it('returns ineligible for missing env vars', async () => {
    const result = await checkRequirements({
      env: ['__MOZI_TEST_NONEXISTENT_ENV_VAR__'],
    });
    expect(result.eligible).toBe(false);
    expect(result.missingEnv).toContain('__MOZI_TEST_NONEXISTENT_ENV_VAR__');
  });

  it('combines bins and env checks', async () => {
    const result = await checkRequirements({
      bins: ['__nonexistent__'],
      env: ['__MOZI_NONEXISTENT__'],
    });
    expect(result.eligible).toBe(false);
    expect(result.missingBins).toContain('__nonexistent__');
    expect(result.missingEnv).toContain('__MOZI_NONEXISTENT__');
  });

  it('rejects binary names with command injection attempts', async () => {
    const result = await checkRequirements({
      bins: ['node; rm -rf /', 'valid$(whoami)', '`cat /etc/passwd`'],
    });
    expect(result.eligible).toBe(false);
    // All should be reported as missing (rejected by validation)
    expect(result.missingBins).toHaveLength(3);
  });

  it('rejects binary names with spaces or special chars', async () => {
    const result = await checkRequirements({
      bins: ['my binary', '../../../bin/sh', 'bin|cat'],
    });
    expect(result.eligible).toBe(false);
    expect(result.missingBins).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// formatSkillsForPrompt
// ---------------------------------------------------------------------------

describe('formatSkillsForPrompt', () => {
  const makeSkill = (overrides: Partial<LoadedSkill> = {}): LoadedSkill => ({
    name: 'test-skill',
    description: 'A test skill',
    instructions: 'Do the thing.',
    frontmatter: {
      name: 'test-skill',
      description: 'A test skill',
    },
    filePath: '/fake/path/SKILL.md',
    directoryName: 'test-skill',
    source: 'bundled',
    enabled: true,
    eligible: true,
    ...overrides,
  });

  it('formats eligible skills into compact catalog lines without non-always bodies', () => {
    const skills = [makeSkill()];
    const result = formatSkillsForPrompt(skills);

    expect(result).toContain('## Available Skills');
    expect(result).toContain('Call `use_skill` with the exact skill name to activate full instructions under `## Active Skills`');
    expect(result).toContain('- test-skill: A test skill');
    expect(result).not.toContain('### test-skill');
    expect(result).not.toContain('Do the thing.');
  });

  it('excludes ineligible skills', () => {
    const skills = [makeSkill({ eligible: false })];
    const result = formatSkillsForPrompt(skills);
    expect(result).toBe('');
  });

  it('excludes disabled skills', () => {
    const skills = [makeSkill({ enabled: false })];
    const result = formatSkillsForPrompt(skills);
    expect(result).toBe('');
  });

  it('excludes skills with disable-model-invocation', () => {
    const fm: SkillFrontmatter = {
      name: 'hidden',
      description: 'hidden skill',
      'disable-model-invocation': true,
    };
    const skills = [makeSkill({ frontmatter: fm })];
    const result = formatSkillsForPrompt(skills);
    expect(result).toBe('');
  });

  it('includes every eligible skill in the catalog', () => {
    const skills = [
      makeSkill({ name: 'skill-a', description: 'A' }),
      makeSkill({ name: 'skill-b', description: 'B' }),
    ];
    const result = formatSkillsForPrompt(skills);
    expect(result).toContain('- skill-a: A');
    expect(result).toContain('- skill-b: B');
    expect(result).not.toContain('---');
  });

  it('returns empty string when no eligible skills', () => {
    expect(formatSkillsForPrompt([])).toBe('');
  });

  it('keeps always skills as full body injection', () => {
    const alwaysSkill = makeSkill({
      name: 'always-skill',
      description: 'Always included',
      instructions: 'Always follow this full body.',
      frontmatter: {
        name: 'always-skill',
        description: 'Always included',
        always: true,
      },
    });

    const result = formatSkillsForPrompt([alwaysSkill]);
    expect(result).toContain('- always-skill: Always included');
    expect(result).toContain('## Always-On Skills');
    expect(result).toContain('### always-skill');
    expect(result).toContain('Always follow this full body.');
  });

  it('does not inject full bodies for user-invocable skills even when named or keyword-matched', () => {
    const codingSkill = makeSkill({
      name: 'coding-agent',
      description: 'Delegate coding tasks to managed workers',
      instructions: 'Delegate through the managed worker runtime.',
      frontmatter: {
        name: 'coding-agent',
        description: 'Delegate coding tasks to managed workers',
        'user-invocable': true,
      },
    });

    const result = formatSkillsForPrompt([codingSkill]);
    expect(result).toContain('- coding-agent: Delegate coding tasks to managed workers');
    expect(result).not.toContain('Delegate through the managed worker runtime.');
    expect(result).not.toContain('### coding-agent');
  });
});

// ---------------------------------------------------------------------------
// discoverSkills (real filesystem)
// ---------------------------------------------------------------------------

describe('discoverSkills', () => {
  it('exposes design-impeccable as an always-on skill whose design red lines reach the prompt', async () => {
    const skills = await discoverSkills({
      bundledDir: BUNDLED_SKILLS_DIR,
      workspaceDir: '/tmp/__mozi_test_nonexistent_workspace__/skills',
    });
    const design = skills.find(s => s.name === 'design-impeccable');
    expect(design).toBeDefined();
    expect(design!.frontmatter.always).toBe(true);
    expect(design!.eligible).toBe(true);

    // Always-on → full body is injected every turn so the Brain always has the
    // design standard when it might emit visual output.
    const prompt = formatSkillsForPrompt(skills);
    expect(prompt).toContain('## Always-On Skills');
    expect(prompt).toContain('### design-impeccable');
    expect(prompt).toContain('AI slop');
  });

  it('discovers the workflow skills that replaced regex-routed task modules', async () => {
    const skills = await discoverSkills({
      bundledDir: BUNDLED_SKILLS_DIR,
      workspaceDir: '/tmp/__mozi_test_nonexistent_workspace__/skills',
    });
    const names = skills.map(s => s.name);

    // These carry the guidance that src/templates/modules/*.md used to inject
    // via detectTaskType(); the Brain now pulls them on demand via use_skill.
    for (const expected of [
      'research-workflow',
      'document-authoring',
      'data-analysis',
      'creative-writing',
      'financial-analysis',
      'self-ops',
    ]) {
      expect(names).toContain(expected);
    }

    // They must be catalog-routed, not always-on: the whole point is paying
    // for the instructions only when the Brain activates them.
    for (const name of ['research-workflow', 'self-ops']) {
      const skill = skills.find(s => s.name === name);
      expect(skill?.frontmatter.always).not.toBe(true);
      expect(skill?.eligible).toBe(true);
    }
  });

  it('discovers bundled skills from root skills/', async () => {
    const skills = await discoverSkills({
      bundledDir: BUNDLED_SKILLS_DIR,
      workspaceDir: '/tmp/__mozi_test_nonexistent_workspace__/skills',
    });

    expect(skills.length).toBeGreaterThan(0);

    // All should be bundled source since workspace dir doesn't exist
    for (const skill of skills) {
      expect(skill.source).toBe('bundled');
      expect(skill.name).toBeTruthy();
      expect(skill.description).toBeTruthy();
      expect(skill.filePath).toContain('SKILL.md');
    }
  });

  it('each discovered skill has valid structure', async () => {
    const skills = await discoverSkills({
      bundledDir: BUNDLED_SKILLS_DIR,
      workspaceDir: '/tmp/__mozi_test_nonexistent_workspace__/skills',
    });

    for (const skill of skills) {
      expect(typeof skill.name).toBe('string');
      expect(typeof skill.description).toBe('string');
      expect(typeof skill.instructions).toBe('string');
      expect(typeof skill.eligible).toBe('boolean');
      expect(['bundled', 'workspace']).toContain(skill.source);
    }
  });

  it('returns empty array for nonexistent directories', async () => {
    const skills = await discoverSkills({
      bundledDir: '/tmp/__nonexistent_a__',
      workspaceDir: '/tmp/__nonexistent_b__',
    });
    expect(skills).toEqual([]);
  });

  it('workspace skills override bundled skills with same name', async () => {
    // This test verifies the override logic by checking the code path.
    // We use the bundled dir for both, which means later (workspace) wins.
    const skills = await discoverSkills({
      bundledDir: BUNDLED_SKILLS_DIR,
      workspaceDir: BUNDLED_SKILLS_DIR, // same dir = same names = workspace wins
    });

    for (const skill of skills) {
      // All should show 'workspace' since it's processed second and overwrites
      expect(skill.source).toBe('workspace');
    }
  });

  it('uses the discovery cache until explicitly cleared', async () => {
    const bundledDir = createTempDir();
    const workspaceDir = createTempDir();
    try {
      const skillDir = join(bundledDir, 'cached-skill');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), `---
name: cached-skill
description: version one
---

Body v1.
`);

      clearSkillDiscoveryCache();
      const first = await discoverSkills({ bundledDir, workspaceDir });
      expect(first.find(skill => skill.name === 'cached-skill')?.description).toBe('version one');

      writeFileSync(join(skillDir, 'SKILL.md'), `---
name: cached-skill
description: version two
---

Body v2.
`);

      const cached = await discoverSkills({ bundledDir, workspaceDir });
      expect(cached.find(skill => skill.name === 'cached-skill')?.description).toBe('version one');

      clearSkillDiscoveryCache();
      const refreshed = await discoverSkills({ bundledDir, workspaceDir });
      expect(refreshed.find(skill => skill.name === 'cached-skill')?.description).toBe('version two');
    } finally {
      clearSkillDiscoveryCache();
      removeTempDir(bundledDir);
      removeTempDir(workspaceDir);
    }
  });
});
