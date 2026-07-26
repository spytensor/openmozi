import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { clearAgentDefinitionCache } from '../agents/definition-loader.js';
import { registerAgentDefinitionRoutes } from './agent-definition-routes.js';

let root = '';
let bundledDir = '';
let workspaceDir = '';
let bundledSkillsDir = '';
let workspaceSkillsDir = '';

function makeApp() {
  const app = Fastify();
  registerAgentDefinitionRoutes(app, { bundledDir, workspaceDir, bundledSkillsDir, workspaceSkillsDir });
  return app;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mozi-agent-api-'));
  bundledDir = join(root, 'bundled');
  workspaceDir = join(root, 'workspace');
  bundledSkillsDir = join(root, 'skills');
  workspaceSkillsDir = join(root, 'workspace-skills');
  mkdirSync(join(bundledDir, 'reviewer'), { recursive: true });
  writeFileSync(join(bundledDir, 'reviewer', 'AGENT.md'), `---
name: reviewer
description: Reviews code
skills: []
permission_level: L0_READ_ONLY
---

Review carefully.
`, 'utf-8');
  clearAgentDefinitionCache();
});

afterEach(() => {
  clearAgentDefinitionCache();
  rmSync(root, { recursive: true, force: true });
});

describe('/api/agents', () => {
  it('creates AGENT.md on disk and immediately exposes it through list and detail', async () => {
    const app = makeApp();
    const payload = {
      name: 'analyst',
      description: 'Analyzes evidence',
      persona: 'Analyze the evidence and cite gaps.',
      model: 'claude-cli/sonnet',
      skills: [],
      tools: ['filesystem'],
      permission_level: 'L0_READ_ONLY',
      color: 'slate',
    };
    const created = await app.inject({ method: 'POST', url: '/api/agents', payload });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ agent: { id: 'workspace:analyst', status: 'ready' } });
    const file = join(workspaceDir, 'analyst', 'AGENT.md');
    expect(readFileSync(file, 'utf-8')).toContain('Analyze the evidence and cite gaps.');

    const listed = await app.inject({ method: 'GET', url: '/api/agents' });
    expect(listed.json().agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'workspace:analyst', source: 'workspace' }),
      expect.objectContaining({ id: 'bundled:reviewer', source: 'bundled' }),
    ]));
    const detail = await app.inject({ method: 'GET', url: '/api/agents/workspace:analyst' });
    expect(detail.json().agent.content).toContain('name: analyst');
    await app.close();
  });

  it('updates, disables, enables, and deletes a workspace definition', async () => {
    const app = makeApp();
    const base = { name: 'writer', description: 'Writes', persona: 'Write.', skills: [] };
    await app.inject({ method: 'POST', url: '/api/agents', payload: base });
    const updated = await app.inject({
      method: 'PUT',
      url: '/api/agents/workspace:writer',
      payload: { ...base, name: 'brief-writer', description: 'Writes clearly', persona: 'Write clearly.' },
    });
    expect(updated.json().agent).toMatchObject({
      id: 'workspace:brief-writer',
      description: 'Writes clearly',
      persona: 'Write clearly.',
    });
    expect(existsSync(join(workspaceDir, 'writer'))).toBe(false);
    expect(existsSync(join(workspaceDir, 'brief-writer', 'AGENT.md'))).toBe(true);

    const disabled = await app.inject({
      method: 'POST', url: '/api/agents/workspace:brief-writer/state', payload: { enabled: false },
    });
    expect(disabled.json().agent.status).toBe('disabled');
    expect(existsSync(join(workspaceDir, 'brief-writer', '.disabled'))).toBe(true);
    const enabled = await app.inject({
      method: 'POST', url: '/api/agents/workspace:brief-writer/state', payload: { enabled: true },
    });
    expect(enabled.json().agent.status).toBe('ready');

    expect((await app.inject({ method: 'DELETE', url: '/api/agents/workspace:brief-writer' })).statusCode).toBe(200);
    expect(existsSync(join(workspaceDir, 'brief-writer'))).toBe(false);
    await app.close();
  });

  it('forks a bundled definition on edit, still refuses to delete it, and rejects unsafe names', async () => {
    const app = makeApp();
    // Editing a built-in agent produces the user's own copy; the shipped file
    // is never written, so a packaged app's sealed install tree stays intact.
    const edited = { name: 'reviewer', description: 'Changed', persona: 'Mine.', skills: [] };
    const put = await app.inject({ method: 'PUT', url: '/api/agents/bundled:reviewer', payload: edited });
    expect(put.statusCode).toBe(200);
    expect(put.json().agent).toMatchObject({ source: 'workspace', description: 'Changed' });
    expect(existsSync(join(workspaceDir, 'reviewer', 'AGENT.md'))).toBe(true);

    // Once the fork exists it shadows the original, so `bundled:reviewer` no
    // longer resolves to anything visible — 404, not 403. Deleting the fork is
    // the way back to the shipped behaviour.
    expect((await app.inject({
      method: 'DELETE', url: '/api/agents/bundled:reviewer',
    })).statusCode).toBe(404);
    expect((await app.inject({
      method: 'DELETE', url: '/api/agents/workspace:reviewer',
    })).statusCode).toBe(200);
    expect(existsSync(join(workspaceDir, 'reviewer'))).toBe(false);
    expect((await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: { name: '../escape', description: 'No', persona: 'No', skills: [] },
    })).statusCode).toBe(400);
    await app.close();
  });
});
