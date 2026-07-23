import { describe, expect, it } from 'vitest';
import {
  resolveEffectivePermissionLevel,
  resolveEffectiveAllowedTools,
  buildSubagentPolicyPrompt,
  buildSubagentToolContext,
} from './subagent-policy.js';

describe('agents/subagent-policy', () => {
  it('does not allow brief permission to elevate env permission', () => {
    const level = resolveEffectivePermissionLevel('L1_READ_WRITE', 'L3_FULL_ACCESS');
    expect(level).toBe('L1_READ_WRITE');
  });

  it('uses stricter brief permission when it is lower than env permission', () => {
    const level = resolveEffectivePermissionLevel('L2_SHELL_EXEC', 'L0_READ_ONLY');
    expect(level).toBe('L0_READ_ONLY');
  });

  it('fails closed on invalid permission values', () => {
    const level = resolveEffectivePermissionLevel('INVALID', 'ALSO_INVALID');
    expect(level).toBe('L0_READ_ONLY');
  });

  it('resolves allowed tools with least-privilege intersection semantics', () => {
    expect(resolveEffectiveAllowedTools([], ['read_file', 'shell_exec']))
      .toEqual(['read_file', 'shell_exec']);
    expect(resolveEffectiveAllowedTools(['read_file', 'write_file'], []))
      .toEqual(['read_file', 'write_file']);
    expect(resolveEffectiveAllowedTools(['read_file', 'write_file'], ['read_file', 'shell_exec']))
      .toEqual(['read_file']);
  });

  it('builds policy prompt with permission and tool constraints', () => {
    const prompt = buildSubagentPolicyPrompt('agent-a', 'tenant-t', 'L1_READ_WRITE', ['read_file']);
    expect(prompt).toContain('permission_level: L1_READ_WRITE');
    expect(prompt).toContain('allowed_tools: read_file');
    expect(prompt).toContain('Never retry the same blocked tool action repeatedly');
  });

  it('builds tool context for executeTool', () => {
    const context = buildSubagentToolContext('task-1', 'tenant-a', 'agent-b', 'L2_SHELL_EXEC');
    expect(context).toEqual({
      chatId: 'task-1',
      taskId: 'task-1',
      tenantId: 'tenant-a',
      agentId: 'agent-b',
      permissionLevel: 'L2_SHELL_EXEC',
    });
  });
});
