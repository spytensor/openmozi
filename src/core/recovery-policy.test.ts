import { describe, expect, it } from 'vitest';
import { extractMissingEnvKeys } from './recovery-policy.js';

describe('core/recovery-policy', () => {
  it('extracts missing env keys from tool error details', () => {
    const keys = extractMissingEnvKeys([
      'SEARCH1API_KEY environment variable is not set',
      'env variable OPENAI_API_KEY missing',
    ]);
    expect(keys).toEqual(['SEARCH1API_KEY', 'OPENAI_API_KEY']);
  });

  it('returns empty array when no env keys are mentioned', () => {
    const keys = extractMissingEnvKeys([
      'Path traversal blocked: /Users/dev/system-file',
      'Tool execution failed: unknown error',
    ]);
    expect(keys).toEqual([]);
  });

  it('caps extracted keys at 3', () => {
    const keys = extractMissingEnvKeys([
      'AAA_KEY environment variable is not set',
      'BBB_KEY environment variable is not set',
      'CCC_KEY environment variable is not set',
      'DDD_KEY environment variable is not set',
    ]);
    expect(keys).toHaveLength(3);
  });

  it('extracts comma-separated keys from blocked environment messages', () => {
    const keys = extractMissingEnvKeys([
      'Task blocked: missing environment variables FOO_API_KEY, BAR_TOKEN',
    ]);
    expect(keys).toEqual(['FOO_API_KEY', 'BAR_TOKEN']);
  });
});
