import { describe, expect, it } from 'vitest';
import type { ToolCall } from '../core/llm.js';
import { ArtifactCoordinator } from '../artifacts/coordinator.js';
import {
  buildExecutionToolContext,
  EXECUTION_CONTEXT_FIELDS,
  SURFACE_CONTEXT_DECLARATIONS,
  type ExecutionSurface,
} from './execution-context.js';
import { executeTool } from './executor.js';
import type { ToolContext } from './types.js';

const surfaces: ExecutionSurface[] = [
  'interactive',
  'dag_step',
  'subagent_fallback',
  'background_job',
  'recovery',
  'proactive',
];

function toolCall(name: string, args: Record<string, unknown>): ToolCall {
  return {
    id: `call-${name}`,
    type: 'function',
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  };
}

function sampleContext(): Partial<ToolContext> {
  return {
    chatId: 'chat-1',
    channelType: 'websocket',
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    userId: 'user-1',
    agentId: 'agent-1',
    permissionLevel: 'L3_FULL_ACCESS',
    scopeGrants: ['/tmp/workspace'],
    abortSignal: new AbortController().signal,
    taskId: 'task-1',
    onArtifact: () => {},
    artifactHints: new Map(),
    turnRichArtifactPaths: new Set(),
    artifactCoordinator: new ArtifactCoordinator('turn-1', () => {}),
    permissionElevationRequests: new Map(),
    writeConfirmedByElevation: true,
    executionModel: { provider: 'openai', model: 'gpt-5.6-luna' },
    systemPrompt: '# SOUL.md — Runtime Identity\nTest delegation identity.',
    originalRequest: 'Create the scheduled report.',
    planDeliveryMode: 'caller',
    turnOrigin: 'scheduler',
  };
}

describe('buildExecutionToolContext', () => {
  it('declares every execution context field as provided or explicitly unsupported', () => {
    for (const surface of surfaces) {
      const context = buildExecutionToolContext(surface, sampleContext());
      const declaration = SURFACE_CONTEXT_DECLARATIONS[surface];
      for (const field of EXECUTION_CONTEXT_FIELDS) {
        const provided = declaration.provides.includes(field) && context[field] !== undefined;
        const explicitlyUnsupported = declaration.unsupported.includes(field)
          && context.executionContext?.unsupported.includes(field) === true
          && context[field] === undefined;
        expect(
          provided || explicitlyUnsupported,
          `${surface}.${field} must be provided or explicitly unsupported`,
        ).toBe(true);
      }
    }
  });

  it('fails closed when a gated tool lacks permissionLevel', async () => {
    const result = await executeTool(
      toolCall('web_fetch', { url: 'https://example.com' }),
      { agentId: 'agent-1', tenantId: 'tenant-1' },
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("tool 'web_fetch' requires permission gate");
    expect(result.content).toContain('[permissionLevel]');
  });

  // Regression: dag_step declared userId unsupported, so buildExecutionToolContext
  // deleted it and every write a plan step made resolved through getWorkspaceDir
  // (undefined) — the shared legacy workspace, which the file API does not serve
  // for a real user. The deliverable landed on disk and its card 404'd.
  it('keeps userId on a dag step, so writes resolve to the user own workspace', () => {
    const context = buildExecutionToolContext('dag_step', {
      userId: 'user-1',
      sessionId: 'sess-1',
      tenantId: 'default',
    });

    expect(context.userId).toBe('user-1');
  });

  // Regression (2026-07-22 incident): dag_step declared turnOrigin unsupported,
  // so buildExecutionToolContext deleted it, isUnattendedContext() saw undefined,
  // and a scheduled plan's write hit the interactive approval wait — an approval
  // card nobody was there to click.
  it('keeps turnOrigin on a dag step, so unattended discipline survives into plan steps', () => {
    const context = buildExecutionToolContext('dag_step', {
      userId: 'user-1',
      sessionId: 'sess-1',
      tenantId: 'default',
      turnOrigin: 'scheduler',
    });

    expect(context.turnOrigin).toBe('scheduler');
  });

  it('declares userId as provided wherever a surface provides sessionId', () => {
    // A surface that knows which session it serves but not whose it is cannot
    // resolve that user's storage — every workspace resolver keys on userId.
    for (const [surface, declaration] of Object.entries(SURFACE_CONTEXT_DECLARATIONS)) {
      if (!declaration.provides.includes('sessionId')) continue;
      expect(declaration.provides, `${surface} provides sessionId but not userId`)
        .toContain('userId');
      expect(declaration.unsupported).not.toContain('userId');
    }
  });

  it('fails closed when a gated tool lacks agentId', async () => {
    const result = await executeTool(
      toolCall('web_fetch', { url: 'https://example.com' }),
      { permissionLevel: 'L3_FULL_ACCESS', tenantId: 'tenant-1' },
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("tool 'web_fetch' requires permission gate");
    expect(result.content).toContain('[agentId]');
  });
});
