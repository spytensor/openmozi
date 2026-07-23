import { describe, it, expect } from 'vitest';
import { fetchUrl, search } from '../../src/capabilities/search.js';

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

describe('capabilities/search (integration)', () => {
  it('search returns one result for query "test"', async (ctx) => {
    if (!process.env.SEARCH1API_KEY) {
      ctx.skip();
      return;
    }

    try {
      const results = await search('test', { max_results: 1 });

      expect(results.length).toBe(1);
      expect(typeof results[0].title).toBe('string');
      expect(typeof results[0].url).toBe('string');
      expect(typeof results[0].snippet).toBe('string');
      expect(results[0].url.length).toBeGreaterThan(0);
    } catch (err) {
      if (isSkippableIntegrationError(err)) {
        ctx.skip();
        return;
      }
      throw err;
    }
  });

  it('fetchUrl returns text truncated by maxChars', async (ctx) => {
    if (!process.env.SEARCH1API_KEY) {
      ctx.skip();
      return;
    }

    try {
      const text = await fetchUrl('https://example.com', 200);

      expect(typeof text).toBe('string');
      expect(text.length).toBeGreaterThan(0);
      expect(text.length).toBeLessThanOrEqual(200);
    } catch (err) {
      if (isSkippableIntegrationError(err)) {
        ctx.skip();
        return;
      }
      throw err;
    }
  });
});
