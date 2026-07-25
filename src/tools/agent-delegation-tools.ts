import { z } from 'zod';
import type { ToolDefinition } from '../core/llm.js';
import { delegateToAgent } from '../agents/delegate-runner.js';
import type { ToolContext, ToolResult } from './types.js';

const DelegateToAgentInputSchema = z.object({
  agent: z.string().min(1),
  brief: z.string().min(1),
  context_refs: z.array(z.string().min(1)).max(20).optional(),
});

export const delegateToAgentTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'delegate_to_agent',
    description: 'Delegate a self-contained brief to a ready file-defined agent. The isolated agent loop returns only a validated result envelope; intermediate agent messages remain in its archived transcript.',
    parameters: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          description: 'Exact agent name from the runtime capability contract.',
        },
        brief: {
          type: 'string',
          description: 'Self-contained task brief written by MOZI, including outcome, constraints, and completion criteria.',
        },
        context_refs: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 20,
          description: 'Optional workspace/output file paths to read into the isolated agent context.',
        },
      },
      required: ['agent', 'brief'],
      additionalProperties: false,
    },
  },
};

export const AGENT_DELEGATION_TOOL_DEFINITIONS: ToolDefinition[] = [delegateToAgentTool];

export async function executeAgentDelegationTool(
  name: string,
  args: Record<string, unknown>,
  id: string,
  context?: ToolContext,
): Promise<ToolResult | null> {
  if (name !== 'delegate_to_agent') return null;
  const parsed = DelegateToAgentInputSchema.parse(args);
  const envelope = await delegateToAgent({
    agent: parsed.agent,
    brief: parsed.brief,
    contextRefs: parsed.context_refs,
    context,
  });
  return {
    tool_call_id: id,
    content: JSON.stringify(envelope),
    is_error: envelope.status !== 'succeeded',
  };
}
