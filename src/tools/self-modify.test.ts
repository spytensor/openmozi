import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb, createTempDir, removeTempDir } from '../test-helpers.js';
import type { LLMClient } from '../core/llm.js';
import { applyModification, getSelfModifications, ensureTable } from './self-modify.js';

let dbTmpDir: string;
let tmpDir: string;
let client: LLMClient;

beforeAll(() => {
  const result = setupTestDb();
  dbTmpDir = result.tmpDir;
  tmpDir = createTempDir();
  client = {
    provider: 'test',
    chat: async () => ({
      content: '',
      usage: { input_tokens: 0, output_tokens: 0 },
      model: 'test',
      stop_reason: null,
    }),
    chatStream: async function* () {},
  };
});

afterAll(() => {
  teardownTestDb(dbTmpDir);
  removeTempDir(tmpDir);
});

describe('self-modify', () => {
  it('rejects files outside src/ directory', async () => {
    const result = await applyModification(
      '../outside.ts',
      'add a comment',
      client,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Security');
    expect(result.rolled_back).toBe(false);
  });

  it('rejects non-existent files', async () => {
    const result = await applyModification(
      'src/does-not-exist-xyz.ts',
      'add a comment',
      client,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('getSelfModifications returns history', () => {
    ensureTable();
    const history = getSelfModifications(10);
    expect(Array.isArray(history)).toBe(true);
  });
});
