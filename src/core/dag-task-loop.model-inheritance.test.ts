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

  it('shapes the live DAG step tool surface by task, not by model', () => {
    const financeTask = {
      title: 'Bond-market quantitative framework',
      objective: 'Analyze the finance market and create a report artifact',
    };
    const shaped = shapeDagStepTools(financeTask, overrideClient, 'deepseek-v4-pro', ALL_TOOLS);
    const names = shaped.tools.map((tool) => tool.function.name);

    expect(shaped.taskProfile).toBe('report');
    expect(names).toEqual(expect.arrayContaining(['create_artifact', 'write_file', 'shell_exec']));
    expect(names).not.toEqual(expect.arrayContaining(['desktop_click', 'git_commit']));
    expect(shaped.shapedCount).toBeLessThan(shaped.originalCount);

    // The same step on a model nobody labelled weak resolves the same surface:
    // narrowing follows the work, not the vendor.
    const strong = shapeDagStepTools(financeTask, overrideClient, 'claude-opus-4-8', ALL_TOOLS);
    expect(strong.tools.map((tool) => tool.function.name)).toEqual(names);
  });
});
