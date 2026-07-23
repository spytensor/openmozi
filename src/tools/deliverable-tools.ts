import type { ToolDefinition } from '../core/llm.js';
import { deliverableRegistry } from '../store/deliverables.js';
import type { ToolContext, ToolResult } from './types.js';

export const findDeliverableTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'find_deliverable',
    description: 'Find registered deliverables by title or exact path text for the current tenant.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Text to match against registered deliverable titles and paths.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
};

export const DELIVERABLE_TOOL_DEFINITIONS: ToolDefinition[] = [findDeliverableTool];

/** Execute registry-only deliverable lookup. */
export async function executeDeliverableTool(
  name: string,
  args: Record<string, unknown>,
  id: string,
  context?: ToolContext,
): Promise<ToolResult | null> {
  if (name !== 'find_deliverable') return null;
  if (typeof args.query !== 'string' || !args.query.trim()) {
    return {
      tool_call_id: id,
      content: 'Error: "query" parameter is required and must be a non-empty string',
      is_error: true,
    };
  }
  const results = deliverableRegistry.search(context?.tenantId ?? 'default', args.query, 10);
  return {
    tool_call_id: id,
    content: JSON.stringify(results),
    is_error: false,
  };
}
