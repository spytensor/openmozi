import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LLMClient } from './llm.js';
import type { TaskRecord } from '../store/task-dag.js';
import { ALL_TOOLS } from '../tools/definitions.js';

const hoisted = vi.hoisted(() => ({
  config: { model_router: { roles: {} as Record<string, unknown> } },
  getClientForRole: vi.fn(),
}));

vi.mock('../config/index.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../config/index.js')>();
  return { ...original, getConfig: () => hoisted.config };
});

vi.mock('./model-router.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./model-router.js')>();
  return { ...original, getClientForRole: hoisted.getClientForRole };
});

import { resolveClient, shapeDagStepTools } from './dag-task-loop.js';

const task = { id: 'task-inherit', tenant_id: 'default' } as TaskRecord;
const inheritedClient = { provider: 'openai', chat: vi.fn(), chatStream: vi.fn() } as unknown as LLMClient;
const overrideClient = { provider: 'deepseek', chat: vi.fn(), chatStream: vi.fn() } as unknown as LLMClient;

describe('DAG step model inheritance', () => {
  beforeEach(() => {
    vi.stubEnv('MOZI_E2E_LLM', '');
    hoisted.config.model_router.roles = {};
    hoisted.getClientForRole.mockReset();
  });

  it('inherits the model selected for the turn when no step override exists', () => {
    const result = resolveClient(task, inheritedClient, { provider: 'openai', model: 'gpt-5.6-luna', think: true });
    expect(result).toEqual({ client: inheritedClient, think: true });
    expect(hoisted.getClientForRole).not.toHaveBeenCalled();
  });

  it('uses an explicitly configured step override', () => {
    hoisted.config.model_router.roles = { step: { provider: 'deepseek', model: 'deepseek-v4-pro' } };
    hoisted.getClientForRole.mockReturnValue({
      client: overrideClient,
      selection: { provider: 'deepseek', model: 'deepseek-v4-pro', role: 'step' },
    });
    expect(resolveClient(task, inheritedClient).client).toBe(overrideClient);
    expect(hoisted.getClientForRole).toHaveBeenCalledWith('step', inheritedClient, { tenantId: 'default' });
  });

  it('uses the same progressive bootstrap surface for every DAG step model', () => {
    const shaped = shapeDagStepTools(ALL_TOOLS);
    const names = shaped.tools.map((tool) => tool.function.name);

    expect(shaped.taskProfile).toBe('model_driven');
    expect(new Set(names)).toEqual(new Set([
      'get_capabilities', 'activate_tools', 'use_skill', 'decompose_task',
    ]));
    expect(shaped.toolCatalog).toContain('create_artifact:');
    expect(shaped.toolCatalog).toContain('shell_exec:');
    expect(shaped.shapedCount).toBeLessThan(shaped.originalCount);
  });
});
