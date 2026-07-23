import { describe, it, expect, afterAll } from 'vitest';
import { getClientForTask, clearCache } from './model-router.js';
import { loadConfig } from '../config/index.js';
import { create } from './llm.js';

// Load config with defaults
loadConfig('/nonexistent/config.yaml');

afterAll(() => {
  clearCache();
});

/** Helper: skip test if error is a billing/credit issue */
function isBillingError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('credit balance') || msg.includes('billing') || msg.includes('quota');
}

function isNetworkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('EAI_AGAIN') || msg.includes('ENOTFOUND') || msg.includes('ECONNREFUSED') || msg.includes('fetch failed');
}

/**
 * Integration tests for model router with real API calls.
 * Tests that the router selects models correctly and can make real calls.
 */
describe('integration', () => {
  it('router selects summary model and makes real call', async (ctx) => {
    // Support both OpenAI and Gemini as summary provider
    if (!process.env.OPENAI_API_KEY && !process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) {
      ctx.skip();
      return;
    }

    const { client, selection } = getClientForTask({ type: 'summary' });

    expect(selection.role).toBe('summary');

    try {
      const response = await client.chat(
        [{ role: 'user', content: 'Say ok' }],
        { max_tokens: 20 }
      );

      expect(response.content).toBeTruthy();
      expect(response.usage.input_tokens).toBeGreaterThan(0);
    } catch (err) {
      if (isBillingError(err) || isNetworkError(err)) {
        ctx.skip();
        return;
      }
      throw err;
    }
  });

  it('router + OpenAI: direct OpenAI client makes real call', async (ctx) => {
    if (!process.env.OPENAI_API_KEY) {
      ctx.skip();
      return;
    }

    // Test that we can create and use an OpenAI client through the LLM layer
    const client = create('openai', { model: 'gpt-4.1-mini' });
    try {
      const response = await client.chat(
        [{ role: 'user', content: 'Say ok' }],
        { max_tokens: 20, model: 'gpt-4.1-mini' }
      );

      expect(response.content).toBeTruthy();
      expect(response.usage.input_tokens).toBeGreaterThan(0);
    } catch (err) {
      if (isBillingError(err) || isNetworkError(err)) {
        ctx.skip();
        return;
      }
      throw err;
    }
  });
});
