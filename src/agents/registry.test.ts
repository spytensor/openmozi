import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { register, get, list, update, remove, findByCapability, findBestForCapability, listCapabilities } from './registry.js';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';

let tmpDir: string;

beforeAll(() => {
  const result = setupTestDb();
  tmpDir = result.tmpDir;
});

afterAll(() => {
  teardownTestDb(tmpDir);
});

describe('agents/registry', () => {
  it('register + get', () => {
    const agent = register({
      id: 'test-coder',
      name: 'Test Coder',
      type: 'preset',
      system_prompt: 'You are a coder.',
      tools_allowed: ['shell', 'filesystem'],
      permission_level: 'L1_READ_WRITE',
    });

    expect(agent.id).toBe('test-coder');
    expect(agent.name).toBe('Test Coder');
    expect(agent.type).toBe('preset');
    expect(agent.tools_allowed).toEqual(['shell', 'filesystem']);
    expect(agent.status).toBe('active');
    expect(agent.spawn_count).toBe(0);

    const fetched = get('test-coder');
    expect(fetched).not.toBeNull();
    expect(fetched!.name).toBe('Test Coder');
  });

  it('get returns null for unknown id', () => {
    expect(get('nonexistent-agent')).toBeNull();
  });

  it('list returns all agents', () => {
    register({
      id: 'test-researcher',
      name: 'Test Researcher',
      type: 'dynamic',
    });

    const agents = list();
    expect(agents.length).toBeGreaterThanOrEqual(2);
    const ids = agents.map((a) => a.id);
    expect(ids).toContain('test-coder');
    expect(ids).toContain('test-researcher');
  });

  it('list filters by type', () => {
    const presets = list({ type: 'preset' });
    expect(presets.every((a) => a.type === 'preset')).toBe(true);

    const dynamics = list({ type: 'dynamic' });
    expect(dynamics.every((a) => a.type === 'dynamic')).toBe(true);
  });

  it('list filters by status', () => {
    const active = list({ status: 'active' });
    expect(active.every((a) => a.status === 'active')).toBe(true);
  });

  it('update modifies fields', () => {
    const updated = update('test-coder', {
      name: 'Updated Coder',
      status: 'inactive',
    });

    expect(updated).not.toBeNull();
    expect(updated!.name).toBe('Updated Coder');
    expect(updated!.status).toBe('inactive');
  });

  it('update returns null for unknown id', () => {
    const result = update('nonexistent', { name: 'x' });
    // update always returns get() result, which is null for unknown
    expect(result).toBeNull();
  });

  it('remove deletes agent', () => {
    register({
      id: 'to-delete',
      name: 'To Delete',
      type: 'dynamic',
    });

    const removed = remove('to-delete');
    expect(removed).toBe(true);
    expect(get('to-delete')).toBeNull();
  });

  it('remove returns false for unknown id', () => {
    expect(remove('never-existed')).toBe(false);
  });

  it('register applies Zod defaults', () => {
    const agent = register({
      id: 'defaults-test',
      name: 'Defaults',
      type: 'preset',
    });

    expect(agent.tenant_id).toBe('default');
    expect(agent.tools_allowed).toEqual([]);
    expect(agent.permission_level).toBe('L0_READ_ONLY');
    expect(agent.status).toBe('active');
    expect(agent.created_by).toBe('system');
  });
});

describe('capability query', () => {
  it('findByCapability returns matching agents', () => {
    register({
      id: 'python-coder',
      name: 'python-coder',
      type: 'dynamic',
      system_prompt: 'You write Python code',
      config: { capabilities: ['code_python', 'test_writing'] },
    });
    register({
      id: 'js-coder',
      name: 'js-coder',
      type: 'dynamic',
      system_prompt: 'You write JavaScript code',
      config: { capabilities: ['code_javascript', 'test_writing'] },
    });

    const pythonAgents = findByCapability('code_python');
    expect(pythonAgents.length).toBe(1);
    expect(pythonAgents[0].name).toBe('python-coder');

    const testAgents = findByCapability('test_writing');
    expect(testAgents.length).toBe(2);
  });

  it('findBestForCapability returns highest evolution_score', () => {
    const agents = findByCapability('test_writing');
    if (agents.length >= 2) {
      update(agents[0].id, { evolution_score: 0.9 });
      update(agents[1].id, { evolution_score: 0.5 });
    }

    const best = findBestForCapability('test_writing');
    expect(best).not.toBeNull();
    expect(best!.evolution_score).toBe(0.9);
  });

  it('findByCapability returns empty for unknown capability', () => {
    const agents = findByCapability('nonexistent_capability');
    expect(agents).toEqual([]);
  });

  it('listCapabilities returns all unique capabilities', () => {
    const caps = listCapabilities();
    expect(caps).toContain('code_python');
    expect(caps).toContain('code_javascript');
    expect(caps).toContain('test_writing');
    // Should be deduplicated
    expect(caps.filter(c => c === 'test_writing').length).toBe(1);
  });

  it('findByCapability isolates by tenant', () => {
    register({
      id: 'tenant2-agent',
      name: 'tenant2-agent',
      type: 'dynamic',
      tenant_id: 'tenant2',
      config: { capabilities: ['code_python'] },
    });

    const defaultAgents = findByCapability('code_python', 'default');
    const tenant2Agents = findByCapability('code_python', 'tenant2');

    // tenant2 agent should not appear in default tenant results
    expect(defaultAgents.every(a => a.tenant_id === 'default')).toBe(true);
    expect(tenant2Agents.every(a => a.tenant_id === 'tenant2')).toBe(true);
  });
});
