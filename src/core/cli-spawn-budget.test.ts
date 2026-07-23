import { describe, expect, it } from 'vitest';
import {
  assertCliSpawnBudget,
  CliSpawnBudgetError,
  MAX_CLI_SPAWN_ENTRY_BYTES,
  MAX_CLI_SPAWN_TOTAL_BYTES,
} from './cli-spawn-budget.js';

describe('CLI spawn budget', () => {
  it('accepts bounded final argv and environment inputs', () => {
    expect(() => assertCliSpawnBudget('claude', ['-p', 'hello'], { PATH: '/bin' })).not.toThrow();
  });

  it('rejects an oversized argv entry without echoing its value', () => {
    const secret = `sensitive-${'x'.repeat(MAX_CLI_SPAWN_ENTRY_BYTES)}`;
    expect(() => assertCliSpawnBudget('claude', [secret], {})).toThrow(CliSpawnBudgetError);
    try {
      assertCliSpawnBudget('claude', [secret], {});
    } catch (error) {
      expect((error as CliSpawnBudgetError).details).toMatchObject({ kind: 'argv', index: 1 });
      expect(String(error)).not.toContain('sensitive-');
    }
  });

  it('rejects an oversized environment entry without echoing its value', () => {
    const secret = `private-${'y'.repeat(MAX_CLI_SPAWN_ENTRY_BYTES)}`;
    try {
      assertCliSpawnBudget('codex', [], { PRIVATE_TOKEN: secret });
      throw new Error('expected budget failure');
    } catch (error) {
      expect(error).toBeInstanceOf(CliSpawnBudgetError);
      expect((error as CliSpawnBudgetError).details).toMatchObject({ kind: 'env', key: 'PRIVATE_TOKEN' });
      expect(String(error)).not.toContain('private-');
    }
  });

  it('rejects the conservative total budget', () => {
    const env = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [
      `VALUE_${index}`,
      'z'.repeat(Math.floor(MAX_CLI_SPAWN_TOTAL_BYTES / 16)),
    ]));
    expect(() => assertCliSpawnBudget('gemini', [], env)).toThrowError(
      expect.objectContaining({ details: expect.objectContaining({ kind: 'total' }) }),
    );
  });
});
