import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describeWorkspacePromptLayers, scaffoldWorkspace, migrateWorkspaceTemplates } from './index.js';

function createTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'mozi-tpl-test-'));
}

describe('onboarding/template-migration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('scaffoldWorkspace creates USER.md but not SOUL.md/AGENTS.md', () => {
    const workspace = join(tmpDir, 'workspace');
    scaffoldWorkspace(workspace);

    expect(existsSync(join(workspace, 'USER.md'))).toBe(true);
    expect(existsSync(join(workspace, 'MEMORY.md'))).toBe(true);
    // System templates should NOT be copied to workspace
    expect(existsSync(join(workspace, 'SOUL.md'))).toBe(false);
    expect(existsSync(join(workspace, 'AGENTS.md'))).toBe(false);
  });

  it('migrateWorkspaceTemplates renames user-edited templates to .local.md', () => {
    const workspace = join(tmpDir, 'workspace');
    mkdirSync(workspace, { recursive: true });

    // Simulate a user-edited SOUL.md (content differs from system version)
    writeFileSync(join(workspace, 'SOUL.md'), '# My Custom Soul\n\nI am unique.\n', 'utf-8');

    migrateWorkspaceTemplates(workspace);

    // The old SOUL.md should be renamed to SOUL.local.md
    expect(existsSync(join(workspace, 'SOUL.local.md'))).toBe(true);
    expect(readFileSync(join(workspace, 'SOUL.local.md'), 'utf-8')).toBe('# My Custom Soul\n\nI am unique.\n');
  });

  it('migrateWorkspaceTemplates does not overwrite existing .local.md files', () => {
    const workspace = join(tmpDir, 'workspace');
    mkdirSync(workspace, { recursive: true });

    // Simulate existing .local.md (already migrated)
    writeFileSync(join(workspace, 'SOUL.local.md'), '# Previous Migration\n', 'utf-8');
    writeFileSync(join(workspace, 'SOUL.md'), '# New Edits\n', 'utf-8');

    migrateWorkspaceTemplates(workspace);

    // Should keep the existing .local.md untouched
    expect(readFileSync(join(workspace, 'SOUL.local.md'), 'utf-8')).toBe('# Previous Migration\n');
    // Original SOUL.md still exists (not renamed since .local.md already exists)
    expect(existsSync(join(workspace, 'SOUL.md'))).toBe(true);
  });

  it('migrateWorkspaceTemplates handles empty workspace gracefully', () => {
    const workspace = join(tmpDir, 'workspace');
    mkdirSync(workspace, { recursive: true });

    // No templates in workspace — should not throw
    expect(() => migrateWorkspaceTemplates(workspace)).not.toThrow();
  });

  it('scaffoldWorkspace runs migration for existing workspaces', () => {
    const workspace = join(tmpDir, 'workspace');
    mkdirSync(workspace, { recursive: true });

    // Simulate pre-existing user-edited AGENTS.md
    writeFileSync(join(workspace, 'AGENTS.md'), '# Custom Agents Config\n', 'utf-8');

    // scaffoldWorkspace should trigger migration
    scaffoldWorkspace(workspace);

    expect(existsSync(join(workspace, 'AGENTS.local.md'))).toBe(true);
    expect(readFileSync(join(workspace, 'AGENTS.local.md'), 'utf-8')).toBe('# Custom Agents Config\n');
  });

  it('describeWorkspacePromptLayers points users at local override files', () => {
    const workspace = join(tmpDir, 'workspace');
    const lines = describeWorkspacePromptLayers(workspace);

    expect(lines.join('\n')).toContain('System prompts update automatically');
    expect(lines.join('\n')).toContain(join(workspace, 'SOUL.local.md'));
    expect(lines.join('\n')).toContain(join(workspace, 'AGENTS.local.md'));
    expect(lines.join('\n')).toContain(join(workspace, 'USER.md'));
  });
});
