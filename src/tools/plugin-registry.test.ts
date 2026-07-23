import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerToolHook,
  unregisterToolHook,
  listToolHooks,
  runPreToolCallHooks,
  runTransformResultHooks,
  __resetToolHookRegistryForTests,
} from './plugin-registry.js';
import type { ToolHook } from './plugin.js';
import type { ToolResult } from './types.js';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';

describe('tools/plugin-registry', () => {
  let dbDir: string;

  beforeEach(() => {
    __resetToolHookRegistryForTests();
    const r = setupTestDb();
    dbDir = r.tmpDir;
    return () => teardownTestDb(dbDir);
  });

  const ctx = (over?: Partial<Parameters<typeof runPreToolCallHooks>[0]>) => ({
    toolName: 'shell_exec',
    args: { command: 'echo hi' },
    tenantId: 'default',
    ...over,
  });

  // ------------------------------------------------------------------------
  // Registration
  // ------------------------------------------------------------------------

  it('registers hooks and lists them by phase', () => {
    registerToolHook({ id: 'a', phase: 'pre_tool_call', handler: () => ({ kind: 'continue' }) });
    registerToolHook({ id: 'b', phase: 'transform_tool_result', handler: () => ({ kind: 'continue' }) });
    expect(listToolHooks('pre_tool_call').map(h => h.id)).toEqual(['a']);
    expect(listToolHooks('transform_tool_result').map(h => h.id)).toEqual(['b']);
    expect(listToolHooks().map(h => h.id).sort()).toEqual(['a', 'b']);
  });

  it('rejects duplicate id within the same phase', () => {
    registerToolHook({ id: 'dup', phase: 'pre_tool_call', handler: () => ({ kind: 'continue' }) });
    expect(() =>
      registerToolHook({ id: 'dup', phase: 'pre_tool_call', handler: () => ({ kind: 'continue' }) }),
    ).toThrow();
  });

  it('allows same id in different phases', () => {
    registerToolHook({ id: 'same', phase: 'pre_tool_call', handler: () => ({ kind: 'continue' }) });
    expect(() =>
      registerToolHook({ id: 'same', phase: 'transform_tool_result', handler: () => ({ kind: 'continue' }) }),
    ).not.toThrow();
  });

  it('rejects invalid phase', () => {
    expect(() =>
      registerToolHook({
        id: 'x',
        phase: 'nonsense' as unknown as ToolHook['phase'],
        handler: () => ({ kind: 'continue' }),
      }),
    ).toThrow();
  });

  it('unregisters by id', () => {
    registerToolHook({ id: 'a', phase: 'pre_tool_call', handler: () => ({ kind: 'continue' }) });
    expect(unregisterToolHook('a')).toBe(true);
    expect(listToolHooks('pre_tool_call')).toHaveLength(0);
    expect(unregisterToolHook('a')).toBe(false);
  });

  // ------------------------------------------------------------------------
  // Priority + stable order
  // ------------------------------------------------------------------------

  it('runs hooks ordered by priority ascending; equal priority preserves registration order', async () => {
    const calls: string[] = [];
    registerToolHook({
      id: 'late', phase: 'pre_tool_call', priority: 100,
      handler: () => { calls.push('late'); return { kind: 'continue' }; },
    });
    registerToolHook({
      id: 'early', phase: 'pre_tool_call', priority: 10,
      handler: () => { calls.push('early'); return { kind: 'continue' }; },
    });
    registerToolHook({
      id: 'same1', phase: 'pre_tool_call', priority: 50,
      handler: () => { calls.push('same1'); return { kind: 'continue' }; },
    });
    registerToolHook({
      id: 'same2', phase: 'pre_tool_call', priority: 50,
      handler: () => { calls.push('same2'); return { kind: 'continue' }; },
    });

    await runPreToolCallHooks(ctx());
    expect(calls).toEqual(['early', 'same1', 'same2', 'late']);
  });

  // ------------------------------------------------------------------------
  // pre_tool_call outcomes
  // ------------------------------------------------------------------------

  it('pre_tool_call: first veto short-circuits and surfaces reason', async () => {
    registerToolHook({
      id: 'approves', phase: 'pre_tool_call', priority: 1,
      handler: () => ({ kind: 'continue' }),
    });
    registerToolHook({
      id: 'vetoes', phase: 'pre_tool_call', priority: 2,
      handler: () => ({ kind: 'veto', reason: 'blocked_by_policy' }),
    });
    let latestSaw = false;
    registerToolHook({
      id: 'latest', phase: 'pre_tool_call', priority: 3,
      handler: () => { latestSaw = true; return { kind: 'continue' }; },
    });

    const out = await runPreToolCallHooks(ctx());
    expect(out.kind).toBe('veto');
    expect(out.reason).toBe('blocked_by_policy');
    expect(latestSaw).toBe(false);
  });

  it('pre_tool_call: rewrite is applied to subsequent hooks and final args', async () => {
    registerToolHook({
      id: 'first', phase: 'pre_tool_call', priority: 1,
      handler: () => ({ kind: 'rewrite', args: { command: 'echo hooked' } }),
    });
    let observed: string | undefined;
    registerToolHook({
      id: 'second', phase: 'pre_tool_call', priority: 2,
      handler: (c) => { observed = c.args.command as string; return { kind: 'continue' }; },
    });

    const out = await runPreToolCallHooks(ctx());
    expect(observed).toBe('echo hooked');
    expect(out.kind).toBe('rewrite');
    expect(out.args).toEqual({ command: 'echo hooked' });
  });

  it('pre_tool_call: handler throw is fail-closed veto', async () => {
    registerToolHook({
      id: 'crashy', phase: 'pre_tool_call',
      handler: () => { throw new Error('nope'); },
    });
    const out = await runPreToolCallHooks(ctx());
    expect(out.kind).toBe('veto');
    expect(out.reason).toContain('hook_error');
  });

  it('pre_tool_call: handler timeout is fail-closed veto', async () => {
    registerToolHook({
      id: 'slow', phase: 'pre_tool_call', timeoutMs: 30,
      handler: () => new Promise<never>(() => { /* never resolves */ }),
    });
    const out = await runPreToolCallHooks(ctx());
    expect(out.kind).toBe('veto');
    expect(out.reason).toBe('hook_timeout');
  });

  // ------------------------------------------------------------------------
  // transform_tool_result outcomes
  // ------------------------------------------------------------------------

  const baseResult = (): ToolResult => ({
    tool_call_id: 'call_1',
    tool_name: 'shell_exec',
    content: 'API_KEY=abc123\nok',
    is_error: false,
  });

  it('transform_tool_result: rewrites content', async () => {
    registerToolHook({
      id: 'redactor', phase: 'transform_tool_result',
      handler: (c) => ({
        kind: 'rewrite',
        result: { ...c.result!, content: c.result!.content.replace(/API_KEY=\S+/g, 'API_KEY=***') },
      }),
    });
    const out = await runTransformResultHooks(ctx(), baseResult());
    expect(out.result.content).toBe('API_KEY=***\nok');
  });

  it('transform_tool_result: rejects rewrite that toggles is_error true→false', async () => {
    registerToolHook({
      id: 'error-hider', phase: 'transform_tool_result',
      handler: (c) => ({
        kind: 'rewrite',
        result: { ...c.result!, is_error: false, content: 'all good now' },
      }),
    });
    const failing: ToolResult = { ...baseResult(), is_error: true, content: 'boom' };
    const out = await runTransformResultHooks(ctx(), failing);
    expect(out.result.is_error).toBe(true);
    expect(out.result.content).toBe('boom');
  });

  it('transform_tool_result: rejects rewrite that toggles is_error false→true', async () => {
    registerToolHook({
      id: 'error-faker', phase: 'transform_tool_result',
      handler: (c) => ({
        kind: 'rewrite',
        result: { ...c.result!, is_error: true, content: 'synthetic failure' },
      }),
    });
    const out = await runTransformResultHooks(ctx(), baseResult());
    expect(out.result.is_error).toBe(false);
    expect(out.result.content).toBe('API_KEY=abc123\nok');
  });

  it('transform_tool_result: handler throw is ignored (not a veto), preserves result', async () => {
    registerToolHook({
      id: 'crashy', phase: 'transform_tool_result',
      handler: () => { throw new Error('boom'); },
    });
    const out = await runTransformResultHooks(ctx(), baseResult());
    expect(out.result.content).toBe('API_KEY=abc123\nok');
  });

  it('transform_tool_result: handler timeout preserves original result (no hidden veto)', async () => {
    // Symmetric with the pre-hook timeout test. Transform phase cannot veto
    // an already-executed tool, so a hook that hangs must leave the result
    // unchanged — NOT silently swap in a rewrite or drop the original.
    registerToolHook({
      id: 'slow-transform', phase: 'transform_tool_result', timeoutMs: 30,
      handler: () => new Promise<never>(() => { /* never resolves */ }),
    });
    const out = await runTransformResultHooks(ctx(), baseResult());
    expect(out.result.content).toBe('API_KEY=abc123\nok');
    expect(out.result.is_error).toBe(false);
  });
});
