import { describe, it, expect } from 'vitest';
import { compress } from './running-summary.js';
import { loadConfig } from '../config/index.js';
import type { ChatMessage } from './llm.js';

// Configure model router to use cheap OpenAI model for summary role.
loadConfig();

function isSkippableIntegrationError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('EAI_AGAIN')
    || msg.includes('ENOTFOUND')
    || msg.includes('ECONNREFUSED')
    || msg.includes('fetch failed')
    || msg.includes('quota')
    || msg.includes('billing')
    || msg.includes('credit balance');
}

describe('integration/running-summary', () => {
  it('compresses dialogue exceeding threshold (real LLM call)', async (ctx) => {
    if (!process.env.OPENAI_API_KEY && !process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) {
      ctx.skip();
      return;
    }

    const turns: ChatMessage[] = Array.from({ length: 8 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `Turn ${i + 1}: ${i % 2 === 0 ? 'I need help with TypeScript strict mode configuration.' : 'Sure, you can enable strict mode in tsconfig.json by setting strict: true.'}`,
    }));

    try {
      const result = await compress(turns, 5, 4);
      expect(result.summary.length).toBeGreaterThan(0);
      expect(result.kept_turns.length).toBe(4);
      expect(result.summary_tokens).toBeGreaterThan(0);
      expect(result.summary_tokens).toBeLessThan(3000);
    } catch (err) {
      if (isSkippableIntegrationError(err)) {
        ctx.skip();
        return;
      }
      throw err;
    }
  });
});
