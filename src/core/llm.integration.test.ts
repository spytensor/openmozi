import { describe, it, expect } from 'vitest';
import { create } from './llm.js';

/**
 * Integration tests that make REAL API calls.
 * Token budget: max 6 total calls (3 anthropic, 3 openai).
 * Use cheapest models and minimal prompts.
 */

/** Helper: skip test if error is a billing/credit issue */
function isBillingError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('credit balance') || msg.includes('billing') || msg.includes('quota');
}

function isNetworkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('EAI_AGAIN') || msg.includes('ENOTFOUND') || msg.includes('ECONNREFUSED') || msg.includes('fetch failed');
}

function isAuthConfigError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('Could not resolve authentication method') || msg.includes('API key');
}

describe('integration', () => {
  describe('Anthropic adapter', () => {
    const client = create('anthropic', { model: 'claude-sonnet-4-20250514' });

    it('chat returns non-empty response with usage', async (ctx) => {
      if (!process.env.ANTHROPIC_API_KEY) {
        ctx.skip();
        return;
      }
      try {
        const response = await client.chat(
          [{ role: 'user', content: 'Say hi' }],
          { max_tokens: 50, model: 'claude-sonnet-4-20250514' }
        );

        expect(response.content).toBeTruthy();
        expect(response.content.length).toBeGreaterThan(0);
        expect(response.usage.input_tokens).toBeGreaterThan(0);
        expect(response.usage.output_tokens).toBeGreaterThan(0);
        expect(response.model).toBeTruthy();
      } catch (err) {
        if (isBillingError(err)) {
          ctx.skip();
          return;
        }
        if (isNetworkError(err) || isAuthConfigError(err)) {
          ctx.skip();
          return;
        }
        throw err;
      }
    });

    it('streaming collects chunks and final response', async (ctx) => {
      if (!process.env.ANTHROPIC_API_KEY) {
        ctx.skip();
        return;
      }
      try {
        const chunks: string[] = [];
        let finalResponse: any = null;

        for await (const chunk of client.chatStream(
          [{ role: 'user', content: 'Say ok' }],
          { max_tokens: 20, model: 'claude-sonnet-4-20250514' }
        )) {
          if (chunk.type === 'text' && chunk.text) {
            chunks.push(chunk.text);
          }
          if (chunk.type === 'done') {
            finalResponse = chunk.response;
          }
        }

        expect(chunks.length).toBeGreaterThan(0);
        const fullText = chunks.join('');
        expect(fullText.length).toBeGreaterThan(0);
        expect(finalResponse).toBeTruthy();
        expect(finalResponse.content.length).toBeGreaterThan(0);
        expect(finalResponse.usage.input_tokens).toBeGreaterThan(0);
      } catch (err) {
        if (isBillingError(err)) {
          ctx.skip();
          return;
        }
        if (isNetworkError(err) || isAuthConfigError(err)) {
          ctx.skip();
          return;
        }
        throw err;
      }
    });
  });

  describe('OpenAI adapter', () => {
    const client = create('openai', { model: 'gpt-4.1-mini' });

    it('chat returns non-empty response with usage', async (ctx) => {
      if (!process.env.OPENAI_API_KEY) {
        ctx.skip();
        return;
      }
      try {
        const response = await client.chat(
          [{ role: 'user', content: 'Say hi' }],
          { max_tokens: 50, model: 'gpt-4.1-mini' }
        );

        expect(response.content).toBeTruthy();
        expect(response.content.length).toBeGreaterThan(0);
        expect(response.usage.input_tokens).toBeGreaterThan(0);
        expect(response.usage.output_tokens).toBeGreaterThan(0);
        expect(response.model).toBeTruthy();
      } catch (err) {
        if (isBillingError(err) || isNetworkError(err) || isAuthConfigError(err)) {
          ctx.skip();
          return;
        }
        throw err;
      }
    });

    it('streaming collects chunks and final response', async (ctx) => {
      if (!process.env.OPENAI_API_KEY) {
        ctx.skip();
        return;
      }
      try {
        const chunks: string[] = [];
        let finalResponse: any = null;

        for await (const chunk of client.chatStream(
          [{ role: 'user', content: 'Say ok' }],
          { max_tokens: 20, model: 'gpt-4.1-mini' }
        )) {
          if (chunk.type === 'text' && chunk.text) {
            chunks.push(chunk.text);
          }
          if (chunk.type === 'done') {
            finalResponse = chunk.response;
          }
        }

        expect(chunks.length).toBeGreaterThan(0);
        const fullText = chunks.join('');
        expect(fullText.length).toBeGreaterThan(0);
        expect(finalResponse).toBeTruthy();
        expect(finalResponse.content.length).toBeGreaterThan(0);
      } catch (err) {
        if (isBillingError(err) || isNetworkError(err) || isAuthConfigError(err)) {
          ctx.skip();
          return;
        }
        throw err;
      }
    });
  });

  describe('Google Gemini adapter', () => {
    const client = create('google', { model: 'gemini-3.1-flash-lite-preview' });

    it('chat returns non-empty response with usage', async (ctx) => {
      if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) {
        ctx.skip();
        return;
      }
      try {
        const response = await client.chat(
          [{ role: 'user', content: 'Say hi' }],
          { max_tokens: 50, model: 'gemini-3.1-flash-lite-preview' }
        );

        expect(response.content).toBeTruthy();
        expect(response.content.length).toBeGreaterThan(0);
        expect(response.usage.input_tokens).toBeGreaterThan(0);
        expect(response.usage.output_tokens).toBeGreaterThan(0);
        expect(response.model).toBeTruthy();
      } catch (err) {
        if (isBillingError(err) || isNetworkError(err) || isAuthConfigError(err)) {
          ctx.skip();
          return;
        }
        throw err;
      }
    });

    it('streaming collects chunks and final response', async (ctx) => {
      if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) {
        ctx.skip();
        return;
      }
      try {
        const chunks: string[] = [];
        let finalResponse: any = null;

        for await (const chunk of client.chatStream(
          [{ role: 'user', content: 'Say ok' }],
          { max_tokens: 20, model: 'gemini-3.1-flash-lite-preview' }
        )) {
          if (chunk.type === 'text' && chunk.text) {
            chunks.push(chunk.text);
          }
          if (chunk.type === 'done') {
            finalResponse = chunk.response;
          }
        }

        expect(chunks.length).toBeGreaterThan(0);
        const fullText = chunks.join('');
        expect(fullText.length).toBeGreaterThan(0);
        expect(finalResponse).toBeTruthy();
        expect(finalResponse.content.length).toBeGreaterThan(0);
      } catch (err) {
        if (isBillingError(err) || isNetworkError(err) || isAuthConfigError(err)) {
          ctx.skip();
          return;
        }
        throw err;
      }
    });
  });
});
