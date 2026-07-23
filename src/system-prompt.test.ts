import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MoziConfigSchema } from './config/index.js';
import { loadDelegationSystemPrompt, loadSystemPrompt } from './system-prompt.js';
import { setupTestDb, teardownTestDb } from './test-helpers.js';

let dbTmpDir: string;
let workspaceTmpDir: string;

beforeAll(() => {
  dbTmpDir = setupTestDb().tmpDir;
  workspaceTmpDir = mkdtempSync(join(tmpdir(), 'mozi-system-prompt-'));
});

afterAll(() => {
  teardownTestDb(dbTmpDir);
  rmSync(workspaceTmpDir, { recursive: true, force: true });
});

describe('system prompt assembly', () => {
  it('keeps generic user turns focused on capabilities instead of product self-reference', () => {
    const base = MoziConfigSchema.parse({});
    const prompt = loadSystemPrompt({
      ...base,
      workspace: {
        ...base.workspace,
        dir: workspaceTmpDir,
      },
    });

    expect(prompt).toContain('## Product Boundary');
    expect(prompt).toContain('## Visual Output & Aesthetics');
    expect(prompt).toContain('No emoji, ever, unless the user explicitly asks for emoji.');
    expect(prompt).toContain('This is the global floor even when the frontend-design skill is not loaded');
    expect(prompt).toContain('## Runtime Capability Contract (Authoritative)');
    expect(prompt).toContain('- execution_paths: direct_brain_execution=');
    expect(prompt).toContain('call the get_capabilities tool');
    expect(prompt).toContain('## Runtime Capability Use');

    expect(prompt).not.toContain('You are MOZI');
    expect(prompt).not.toContain('MOZI System');
    expect(prompt).not.toContain('MOZI Runtime Capability Manifest');
    expect(prompt).not.toContain('Your source code');
    expect(prompt).not.toContain('Database location');
    expect(prompt).not.toContain('~/.mozi');
    expect(prompt).not.toContain('pnpm mozi');
  });

  it('injects the full capability contract only on demand, not per turn', () => {
    const base = MoziConfigSchema.parse({});
    const prompt = loadSystemPrompt({
      ...base,
      workspace: { ...base.workspace, dir: workspaceTmpDir },
    });

    // The per-turn prompt carries the compact summary; the full contract
    // (### Runtime Built-ins listing) is served by the get_capabilities tool.
    expect(prompt).not.toContain('### Runtime Built-ins');
    expect(prompt).not.toContain('### Capability Truth Rules');
  });

  it('keeps USER.md in the Brain prompt but excludes it from delegated execution', () => {
    const privateProfileMarker = 'PRIVATE USER PROFILE MARKER';
    writeFileSync(join(workspaceTmpDir, 'USER.md'), privateProfileMarker);
    const base = MoziConfigSchema.parse({});
    const config = {
      ...base,
      workspace: { ...base.workspace, dir: workspaceTmpDir },
    };

    expect(loadSystemPrompt(config)).toContain(privateProfileMarker);
    const delegated = loadDelegationSystemPrompt(config);
    expect(delegated).toContain('# SOUL.md — Runtime Identity');
    expect(delegated).not.toContain(privateProfileMarker);
  });

  it('has no unresolved template placeholders and no duplicated policy sections', () => {
    const base = MoziConfigSchema.parse({});
    const prompt = loadSystemPrompt({
      ...base,
      workspace: { ...base.workspace, dir: workspaceTmpDir },
    });

    // {{CAPABILITIES}}-style placeholders must never leak into the live prompt.
    expect(prompt).not.toMatch(/\{\{[A-Z_]+\}\}/);

    // Every rule must have exactly one owning section: duplicated policy text
    // drifts into contradictions and dilutes instruction following.
    expect(prompt.match(/Technical Counterpart Standard/g)?.length ?? 0).toBe(1);
    expect(prompt.match(/^## Product Boundary$/gm)?.length ?? 0).toBe(1);
    expect(prompt.match(/^## Language$/gm)).toBeNull();

    // H2 headings must be unique across the assembled prompt.
    const headings = prompt.split('\n').filter(line => /^## /.test(line));
    const duplicates = headings.filter((heading, index) => headings.indexOf(heading) !== index);
    expect(duplicates).toEqual([]);
  });
});
