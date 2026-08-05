import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  createAgentDefinition: vi.fn(),
}));

vi.mock('../agents/definition-loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agents/definition-loader.js')>();
  return { ...actual, createAgentDefinition: hoisted.createAgentDefinition };
});

import { executeSystemTool, SYSTEM_TOOLS } from './system-tools.js';

describe('tools/system-tools Agent authoring', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registers create_agent and writes through the managed definition service', async () => {
    hoisted.createAgentDefinition.mockResolvedValueOnce({
      name: 'market-analyst',
      description: 'Analyzes linked equity markets.',
      status: 'ready',
      enabled: true,
      model: undefined,
      skills: ['equity-research'],
      tools: ['filesystem', 'network'],
      permission_level: 'L1_READ_WRITE',
    });

    expect(SYSTEM_TOOLS.map((tool) => tool.function.name)).toContain('create_agent');
    const result = await executeSystemTool('create_agent', {
      name: 'market-analyst',
      description: 'Analyzes linked equity markets.',
      persona: 'You are a rigorous cross-market equity analyst.',
      permission_level: 'L1_READ_WRITE',
      skills: ['equity-research'],
      tool_groups: ['filesystem', 'network'],
    }, 'call-create-agent');

    expect(hoisted.createAgentDefinition).toHaveBeenCalledWith({
      name: 'market-analyst',
      description: 'Analyzes linked equity markets.',
      persona: 'You are a rigorous cross-market equity analyst.',
      permission_level: 'L1_READ_WRITE',
      skills: ['equity-research'],
      tools: ['filesystem', 'network'],
    });
    expect(result).toEqual(expect.objectContaining({
      tool_call_id: 'call-create-agent',
      tool_name: 'create_agent',
      is_error: false,
    }));
    expect(JSON.parse(result!.content)).toEqual({
      agent: expect.objectContaining({ name: 'market-analyst', status: 'ready', enabled: true }),
    });
  });
});
