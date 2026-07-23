import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  saveProjectFact,
  getProjectFacts,
  deleteProjectFact,
  getProjectSection,
  extractProjectKnowledge,
} from './project-context.js';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import { saveFact } from './long-term.js';
import type { LLMClient } from '../core/llm.js';

let tmpDir: string;

beforeAll(() => {
  const result = setupTestDb();
  tmpDir = result.tmpDir;
});

afterAll(() => {
  teardownTestDb(tmpDir);
});

describe('memory/project-context', () => {
  it('saves and retrieves project facts', () => {
    saveProjectFact('tech_stack', 'React + TypeScript', 'fact');
    const facts = getProjectFacts('fact');
    expect(facts.some(f => f.key === 'tech_stack' && f.value === 'React + TypeScript')).toBe(true);
  });

  it('retrieves all categories when no filter specified', () => {
    saveProjectFact('framework', 'Fastify', 'fact');
    saveProjectFact('package_manager', 'pnpm', 'preference');
    saveProjectFact('db_choice', 'SQLite over PostgreSQL', 'decision');
    saveProjectFact('orm_lesson', 'Avoid ORMs for simple queries', 'lesson');

    const all = getProjectFacts();
    expect(all.some(f => f.key === 'framework')).toBe(true);
    expect(all.some(f => f.key === 'package_manager')).toBe(true);
    expect(all.some(f => f.key === 'db_choice')).toBe(true);
    expect(all.some(f => f.key === 'orm_lesson')).toBe(true);
  });

  it('isolates facts by tenant', () => {
    saveProjectFact('tenant_fact', 'value_a', 'fact', undefined, 'tenant_a');
    saveProjectFact('tenant_fact', 'value_b', 'fact', undefined, 'tenant_b');

    const factsA = getProjectFacts('fact', 'tenant_a');
    const factsB = getProjectFacts('fact', 'tenant_b');

    const valA = factsA.find(f => f.key === 'tenant_fact');
    const valB = factsB.find(f => f.key === 'tenant_fact');
    expect(valA?.value).toBe('value_a');
    expect(valB?.value).toBe('value_b');
  });

  it('upserts on duplicate key (same category)', () => {
    saveProjectFact('entry_point', 'src/main.ts', 'fact');
    saveProjectFact('entry_point', 'src/index.ts', 'fact');

    const facts = getProjectFacts('fact');
    const entries = facts.filter(f => f.key === 'entry_point');
    expect(entries).toHaveLength(1);
    expect(entries[0].value).toBe('src/index.ts');
  });

  it('deletes a project fact', () => {
    saveProjectFact('to_delete', 'temporary', 'fact');
    expect(getProjectFacts('fact').some(f => f.key === 'to_delete')).toBe(true);

    deleteProjectFact('to_delete', 'fact');
    expect(getProjectFacts('fact').some(f => f.key === 'to_delete')).toBe(false);
  });

  it('getProjectSection returns empty string when no facts exist', () => {
    const section = getProjectSection('empty_tenant');
    expect(section).toBe('');
  });

  it('getProjectSection formats facts into grouped sections', () => {
    const tid = 'section_test';
    saveProjectFact('runtime', 'Node.js 22', 'fact', undefined, tid);
    saveProjectFact('coding_style', 'strict TypeScript', 'preference', undefined, tid);
    saveProjectFact('api_pattern', 'REST over GraphQL', 'decision', undefined, tid);
    saveProjectFact('perf_lesson', 'Batch DB writes', 'lesson', undefined, tid);

    const section = getProjectSection(tid);
    expect(section).toContain('## Project Knowledge');
    expect(section).toContain('### Architecture');
    expect(section).toContain('[fact] runtime: Node.js 22');
    expect(section).toContain('### Conventions');
    expect(section).toContain('[preference] coding_style: strict TypeScript');
    expect(section).toContain('### Decisions');
    expect(section).toContain('[decision] api_pattern: REST over GraphQL');
    expect(section).toContain('### Lessons');
    expect(section).toContain('[lesson] perf_lesson: Batch DB writes');
  });

  it('getProjectSection omits empty subsections', () => {
    const tid = 'partial_section';
    saveProjectFact('only_fact', 'value', 'fact', undefined, tid);

    const section = getProjectSection(tid);
    expect(section).toContain('### Architecture');
    expect(section).not.toContain('### Conventions');
    expect(section).not.toContain('### Decisions');
    expect(section).not.toContain('### Lessons');
  });

  it('promotes only user assertions into user-scoped project memory', async () => {
    const chat = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        items: [{ key: 'package_manager', value: 'The project uses pnpm.', category: 'preference', action: 'add' }],
      }),
    });
    const client = { chat } as unknown as LLMClient;

    await expect(extractProjectKnowledge(
      '这个项目统一使用 pnpm。',
      client,
      { tenantId: 'trusted-project', userId: 'user-a', chatId: 'chat-a', turnId: 'turn-a' },
    )).resolves.toBe(1);

    const factsA = getProjectFacts(undefined, 'trusted-project', 'user-a');
    const factsB = getProjectFacts(undefined, 'trusted-project', 'user-b');
    expect(factsA).toHaveLength(1);
    expect(factsA[0]).toMatchObject({
      user_id: 'user-a',
      status: 'active',
      origin_kind: 'user',
      source: 'project_user_assertion',
    });
    expect(factsB).toEqual([]);
    const prompt = chat.mock.calls[0][0][1].content as string;
    expect(prompt).toContain('这个项目统一使用 pnpm。');
    expect(prompt).not.toContain('Assistant response');
  });

  it('never creates tenant-global project memory when user identity is unavailable', async () => {
    const chat = vi.fn();
    const client = { chat } as unknown as LLMClient;
    await expect(extractProjectKnowledge('Use SQLite.', client, { tenantId: 'anonymous-project' })).resolves.toBe(0);
    expect(chat).not.toHaveBeenCalled();
    expect(getProjectFacts(undefined, 'anonymous-project')).toEqual([]);
  });

  it('keeps the same project key independent for different users', () => {
    const tenantId = 'project-key-isolation';
    saveProjectFact('runtime', 'Node.js 22', 'fact', 'project_user_assertion', tenantId, 'user-a');
    saveProjectFact('runtime', 'Bun', 'fact', 'project_user_assertion', tenantId, 'user-b');
    expect(getProjectFacts('fact', tenantId, 'user-a')[0].value).toBe('Node.js 22');
    expect(getProjectFacts('fact', tenantId, 'user-b')[0].value).toBe('Bun');
  });

  it('excludes unreviewed legacy assistant extraction from prompt injection', () => {
    const tenantId = 'legacy-quarantine';
    saveFact('__project__', 'fact', 'unsafe_claim', 'The assistant guessed this.', 'project_extraction', tenantId, undefined, undefined, 'pending_review', 'assistant');
    expect(getProjectFacts(undefined, tenantId, undefined, true)).toHaveLength(1);
    expect(getProjectSection(tenantId)).toBe('');
  });
});
