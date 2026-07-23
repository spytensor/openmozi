import { describe, expect, it } from 'vitest';
import type { ToolDefinition } from './llm.js';
import { isStrictToolSchemaCompatible, shouldUseStrictToolCalling } from './ai-sdk-adapter.js';

const strictTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'strict_tool',
    description: 'Strict-compatible tool',
    parameters: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
  },
};

describe('strict tool calling capability gate', () => {
  it('enables strict mode only for a supported provider and compatible schema', () => {
    expect(isStrictToolSchemaCompatible(strictTool.function.parameters)).toBe(true);
    expect(shouldUseStrictToolCalling('openai', strictTool)).toBe(true);
    expect(shouldUseStrictToolCalling('deepseek', strictTool)).toBe(false);
  });

  it('does not claim strict support for optional or composed schemas', () => {
    const optional: ToolDefinition = {
      ...strictTool,
      function: {
        ...strictTool.function,
        parameters: {
          type: 'object',
          properties: { value: { type: 'string' }, optional: { type: 'string' } },
          required: ['value'],
          additionalProperties: false,
        },
      },
    };
    expect(isStrictToolSchemaCompatible(optional.function.parameters)).toBe(false);
    expect(shouldUseStrictToolCalling('openai', optional)).toBe(false);
  });

  it('checks strict compatibility recursively through array item objects', () => {
    const nested = {
      type: 'object',
      properties: {
        rows: {
          type: 'array',
          items: {
            type: 'object',
            properties: { value: { type: 'string' }, note: { type: 'string' } },
            required: ['value'],
            additionalProperties: false,
          },
        },
      },
      required: ['rows'],
      additionalProperties: false,
    };
    expect(isStrictToolSchemaCompatible(nested)).toBe(false);
  });
});
