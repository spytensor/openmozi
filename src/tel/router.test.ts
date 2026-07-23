import { describe, it, expect } from 'vitest';
import { route } from './router.js';

describe('tel/router', () => {
  it('routes shell.execute correctly', () => {
    const result = route({
      category: 'shell',
      action: 'execute',
      params: { command: 'echo hello' },
    });

    expect(result.tool).toBe('shell');
    expect(result.validated_params).toHaveProperty('command', 'echo hello');
    expect(result.validated_params).toHaveProperty('restricted', false); // default
  });

  it('routes filesystem.read correctly', () => {
    const result = route({
      category: 'filesystem',
      action: 'read',
      params: { path: '/tmp/test.txt' },
    });

    expect(result.tool).toBe('filesystem');
    expect(result.validated_params).toHaveProperty('path', '/tmp/test.txt');
  });

  it('routes filesystem.write correctly', () => {
    const result = route({
      category: 'filesystem',
      action: 'write',
      params: { path: '/tmp/test.txt', content: 'hello' },
    });

    expect(result.tool).toBe('filesystem');
    expect(result.validated_params).toHaveProperty('content', 'hello');
  });

  it('rejects unknown category', () => {
    expect(() =>
      route({ category: 'unknown', action: 'do', params: {} })
    ).toThrow('Unknown tool category: unknown');
  });

  it('rejects unknown action for known category', () => {
    expect(() =>
      route({ category: 'shell', action: 'unknown', params: {} })
    ).toThrow('Unknown action "unknown" for category "shell"');
  });

  it('rejects missing required params', () => {
    expect(() =>
      route({ category: 'shell', action: 'execute', params: {} })
    ).toThrow(); // command is required
  });

  it('applies default values for optional params', () => {
    const result = route({
      category: 'filesystem',
      action: 'search',
      params: { path: '/tmp', pattern: '*.txt' },
    });

    expect(result.validated_params).toHaveProperty('recursive', true); // default
  });

  // ── Background process routes ──

  it('routes shell.execute_background correctly', () => {
    const result = route({
      category: 'shell',
      action: 'execute_background',
      params: { command: 'sleep 100' },
    });

    expect(result.tool).toBe('shell');
    expect(result.validated_params).toHaveProperty('command', 'sleep 100');
    expect(result.validated_params).toHaveProperty('restricted', false);
  });

  it('routes shell.process_status correctly', () => {
    const result = route({
      category: 'shell',
      action: 'process_status',
      params: { process_id: 'abc-123' },
    });

    expect(result.tool).toBe('shell');
    expect(result.validated_params).toHaveProperty('process_id', 'abc-123');
  });

  it('routes shell.process_output correctly', () => {
    const result = route({
      category: 'shell',
      action: 'process_output',
      params: { process_id: 'abc-123', tail_lines: 50 },
    });

    expect(result.tool).toBe('shell');
    expect(result.validated_params).toHaveProperty('process_id', 'abc-123');
    expect(result.validated_params).toHaveProperty('tail_lines', 50);
  });

  it('routes shell.process_input correctly', () => {
    const result = route({
      category: 'shell',
      action: 'process_input',
      params: { process_id: 'abc-123', input: 'yes\n' },
    });

    expect(result.tool).toBe('shell');
    expect(result.validated_params).toHaveProperty('input', 'yes\n');
  });

  it('routes shell.process_kill correctly', () => {
    const result = route({
      category: 'shell',
      action: 'process_kill',
      params: { process_id: 'abc-123', signal: 'SIGKILL' },
    });

    expect(result.tool).toBe('shell');
    expect(result.validated_params).toHaveProperty('signal', 'SIGKILL');
  });

  it('rejects shell.process_status without process_id', () => {
    expect(() =>
      route({ category: 'shell', action: 'process_status', params: {} })
    ).toThrow(); // process_id is required
  });
});
