import { describe, expect, it } from 'vitest';
import { getProvider } from './providers.js';

describe('CLI provider prompt delivery contracts', () => {
  it.each([
    ['claude-cli', []],
    ['codex-cli', ['-']],
    ['gemini-cli', ['-p', '']],
  ])('%s activates the 64 KiB stdin fallback', (providerId, stdinPromptArgs) => {
    const backend = getProvider(providerId)?.cliBackend;
    expect(backend?.maxPromptArgBytes).toBe(65_536);
    expect(backend?.stdinPromptArgs ?? []).toEqual(stdinPromptArgs);
  });
});
