import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('LLM module boundaries', () => {
  it('keeps public contracts independent of provider and runtime infrastructure', () => {
    const contracts = readFileSync(new URL('./llm-contracts.ts', import.meta.url), 'utf8');
    expect(contracts).not.toMatch(/from ['"].*providers/);
    expect(contracts).not.toMatch(/from ['"].*(gateway|store|config)/);
  });

  it('keeps the AI SDK adapter independent of gateway and storage modules', () => {
    const adapter = readFileSync(new URL('./ai-sdk-adapter.ts', import.meta.url), 'utf8');
    expect(adapter).not.toMatch(/from ['"].*(gateway|store)/);
  });

  it('keeps the public entrypoint focused on factory orchestration', () => {
    const entrypoint = readFileSync(new URL('./llm.ts', import.meta.url), 'utf8');
    expect(entrypoint).not.toContain('generateText(');
    expect(entrypoint).not.toContain('streamText(');
    expect(entrypoint).not.toContain('recordLlmCall(');
    expect(entrypoint.split('\n').length).toBeLessThan(200);
  });
});
