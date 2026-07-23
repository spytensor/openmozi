import { describe, it, expect, beforeEach } from 'vitest';
import { registerHandler, resolveHandler, listHandlerTypes, clearHandlers } from './registry.js';

describe('Handler Registry', () => {
  beforeEach(() => {
    clearHandlers();
  });

  it('registers and resolves a handler', () => {
    const handler = async () => 'result';
    registerHandler('test', handler);
    expect(resolveHandler('test')).toBe(handler);
  });

  it('returns null for unregistered type', () => {
    expect(resolveHandler('nonexistent')).toBeNull();
  });

  it('returns null for null type', () => {
    expect(resolveHandler(null)).toBeNull();
  });

  it('lists registered types', () => {
    registerHandler('type_a', async () => 'a');
    registerHandler('type_b', async () => 'b');
    expect(listHandlerTypes()).toEqual(['type_a', 'type_b']);
  });

  it('clears all handlers', () => {
    registerHandler('test', async () => 'x');
    clearHandlers();
    expect(listHandlerTypes()).toEqual([]);
    expect(resolveHandler('test')).toBeNull();
  });

  it('overwrites existing handler', () => {
    const first = async () => 'first';
    const second = async () => 'second';
    registerHandler('dup', first);
    registerHandler('dup', second);
    expect(resolveHandler('dup')).toBe(second);
  });
});
