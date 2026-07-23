import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { ProposeSkillArgsSchema, slugify, proposeSkill } from './auto-extract.js';
import { createTempDir, removeTempDir, setupTestDb, teardownTestDb } from '../test-helpers.js';

let workspaceDir: string;
let dbDir: string;

beforeEach(() => {
  workspaceDir = createTempDir();
  mkdirSync(join(workspaceDir, 'skills'), { recursive: true });
  const result = setupTestDb();
  dbDir = result.tmpDir;
});

afterEach(() => {
  teardownTestDb(dbDir);
  removeTempDir(workspaceDir);
});

describe('skills/auto-extract - Zod schema', () => {
  it('accepts a minimal valid proposal', () => {
    const parsed = ProposeSkillArgsSchema.safeParse({
      name: 'Setup Python env',
      description: 'Install a virtualenv and project deps',
      category: 'coding',
      steps: ['python -m venv .venv', 'source .venv/bin/activate', 'pip install -r requirements.txt'],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects when name is missing', () => {
    const parsed = ProposeSkillArgsSchema.safeParse({
      description: 'x',
      category: 'utility',
      steps: ['s'],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an invalid category (violates SKILL-SPEC enum)', () => {
    const parsed = ProposeSkillArgsSchema.safeParse({
      name: 'x',
      description: 'x',
      category: 'not-a-category',
      steps: ['s'],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects empty steps array', () => {
    const parsed = ProposeSkillArgsSchema.safeParse({
      name: 'x',
      description: 'x',
      category: 'utility',
      steps: [],
    });
    expect(parsed.success).toBe(false);
  });
});

describe('skills/auto-extract - slugify', () => {
  it('produces autogen-prefixed lowercase slug', () => {
    expect(slugify('Setup Python Env')).toBe('autogen-setup-python-env');
  });

  it('strips path-traversal characters', () => {
    expect(slugify('../../etc/passwd')).toBe('autogen-etc-passwd');
  });

  it('returns null for all-invalid names', () => {
    expect(slugify('!!!')).toBeNull();
    expect(slugify('   ')).toBeNull();
  });

  it('truncates overly long names', () => {
    const long = 'a'.repeat(200);
    const slug = slugify(long);
    expect(slug).not.toBeNull();
    expect(slug!.length).toBeLessThanOrEqual(64);
  });
});

describe('skills/auto-extract - proposeSkill', () => {
  it('writes a legal SKILL.md under workspaceDir/skills/autogen-<slug>/', async () => {
    const result = await proposeSkill(
      {
        name: 'Setup Python env',
        description: 'Create a virtualenv and install project deps',
        category: 'coding',
        steps: ['python -m venv .venv', 'source .venv/bin/activate', 'pip install -r requirements.txt'],
        when_to_use: 'Repository has a requirements.txt and no .venv yet',
        examples: ['User asks: set up Python for this repo'],
        source_task_id: 'task-123',
      },
      { workspaceDir: join(workspaceDir, 'skills') },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('proposeSkill failed');

    expect(result.slug).toBe('autogen-setup-python-env');
    expect(existsSync(result.filePath)).toBe(true);

    const content = readFileSync(result.filePath, 'utf-8');
    const match = content.match(/^---\n([\s\S]*?)\n---\n/);
    expect(match).not.toBeNull();
    const frontmatter = yaml.load(match![1]) as Record<string, unknown>;

    expect(frontmatter.name).toBe('autogen-setup-python-env');
    expect(frontmatter.category).toBe('coding');
    expect(frontmatter['user-invocable']).toBe(false);
    expect(frontmatter.origin).toBe('autogen');
    expect(frontmatter.source_task_id).toBe('task-123');
    expect((frontmatter.metadata as Record<string, unknown>).sandbox_profile).toBe('read-only');

    expect(content).toContain('## When to Use');
    expect(content).toContain('## How to Execute');
    expect(content).toContain('1. python -m venv .venv');
  });

  it('returns invalid_args on missing required fields', async () => {
    const result = await proposeSkill(
      { name: 'x', category: 'coding' },
      { workspaceDir: join(workspaceDir, 'skills') },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('should have failed');
    expect(result.reason).toBe('invalid_args');
  });

  it('returns invalid_slug on all-unsafe name', async () => {
    const result = await proposeSkill(
      {
        name: '!!!',
        description: 'bad name',
        category: 'utility',
        steps: ['s'],
      },
      { workspaceDir: join(workspaceDir, 'skills') },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('should have failed');
    expect(result.reason).toBe('invalid_slug');
  });

  it('returns already_exists instead of overwriting', async () => {
    const first = await proposeSkill(
      {
        name: 'duplicate demo',
        description: 'first write',
        category: 'utility',
        steps: ['step 1'],
      },
      { workspaceDir: join(workspaceDir, 'skills') },
    );
    expect(first.ok).toBe(true);

    const second = await proposeSkill(
      {
        name: 'duplicate demo',
        description: 'second write',
        category: 'utility',
        steps: ['step 2'],
      },
      { workspaceDir: join(workspaceDir, 'skills') },
    );
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('should have failed');
    expect(second.reason).toBe('already_exists');
  });

  it('blocks ../ path traversal via name (safe slugify defense)', async () => {
    // The slug normalization drops `../` separators entirely, so the name
    // `'../../etc/passwd-text'` must land at `<ws>/skills/autogen-etc-passwd-text/`
    // — inside the workspace, never outside. Hard assertion (no either-or).
    const skillsDir = join(workspaceDir, 'skills');
    const result = await proposeSkill(
      {
        name: '../../etc/passwd-text',
        description: 'x',
        category: 'utility',
        steps: ['s'],
      },
      { workspaceDir: skillsDir },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('should have written safely');
    expect(result.filePath.startsWith(skillsDir + '/')).toBe(true);
    expect(result.filePath).not.toContain('/etc/');
    expect(result.filePath.endsWith('autogen-etc-passwd-text/SKILL.md')).toBe(true);
  });

  it('refuses to write when target slug path is a symlink (planted attack)', async () => {
    const { symlinkSync } = require('node:fs') as typeof import('node:fs');
    const skillsDir = join(workspaceDir, 'skills');
    // Attacker pre-plants `autogen-evil` as a symlink pointing outside workspace.
    const outsideTarget = join(workspaceDir, '..', `outside-${Date.now()}`);
    symlinkSync(outsideTarget, join(skillsDir, 'autogen-evil'));

    const result = await proposeSkill(
      {
        name: 'evil',
        description: 'should not write',
        category: 'utility',
        steps: ['s'],
      },
      { workspaceDir: skillsDir },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('should have refused');
    expect(result.reason).toBe('symlink_target');
    // Nothing should have been created at the symlink target.
    expect(existsSync(outsideTarget)).toBe(false);
  });

  it('listRuntimeSkills hides autogen skills by default, reveals them with includeAutogen', async () => {
    const { listRuntimeSkills } = await import('./workspace-manager.js');
    const skillsDir = join(workspaceDir, 'skills');
    const ok = await proposeSkill(
      {
        name: 'hidden skill',
        description: 'not user-invocable',
        category: 'utility',
        steps: ['s1'],
      },
      { workspaceDir: skillsDir },
    );
    expect(ok.ok).toBe(true);

    const defaultList = await listRuntimeSkills({
      bundledDir: join(workspaceDir, 'no-bundled'),
      workspaceDir: skillsDir,
    });
    expect(defaultList.find(s => s.directory_name === 'autogen-hidden-skill')).toBeUndefined();

    const operatorList = await listRuntimeSkills(
      { bundledDir: join(workspaceDir, 'no-bundled'), workspaceDir: skillsDir },
      { includeAutogen: true },
    );
    const autogen = operatorList.find(s => s.directory_name === 'autogen-hidden-skill');
    expect(autogen).toBeDefined();
    expect(autogen!.user_invocable).toBe(false);
    expect(autogen!.origin).toBe('autogen');
  });
});
