import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Brain execution module boundaries', () => {
  it('keeps the engine focused on orchestration', () => {
    const source = readFileSync(new URL('./brain-engine.ts', import.meta.url), 'utf8');
    expect(source.split('\n').length).toBeLessThan(600);
    expect(source).not.toContain('async function executeStreamingTurn');
    expect(source).not.toContain('async function handleToolCalls');
    expect(source).not.toContain('async function executeRecovery');
  });

  it.each(['brain-artifacts.ts', 'brain-loop-policy.ts', 'brain-turn-handlers.ts'])(
    'keeps %s independent from gateway and store modules',
    (filename) => {
      const source = readFileSync(new URL(filename, import.meta.url), 'utf8');
      expect(source).not.toMatch(/from ['"].*(gateway|store)/);
    },
  );
});
