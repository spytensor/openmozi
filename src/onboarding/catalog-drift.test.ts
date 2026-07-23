import { describe, expect, it } from 'vitest';
import { diffServedModelsAgainstCatalog } from './index.js';
import { getProvider } from '../core/providers.js';

describe('diffServedModelsAgainstCatalog', () => {
  it('flags served chat models missing from the bundled catalog', () => {
    const missing = diffServedModelsAgainstCatalog('moonshot', [
      'kimi-k2.6',        // in catalog → not flagged
      'kimi-k2.5',        // in catalog → not flagged
      'kimi-k9-future',   // not in catalog → flagged
    ]);
    expect(missing).toEqual(['kimi-k9-future']);
  });

  it('ignores non-chat model ids (embeddings, speech, etc.)', () => {
    const missing = diffServedModelsAgainstCatalog('moonshot', [
      'kimi-embedding-v1',
      'kimi-tts-pro',
      'whisper-large',
      'kimi-k9-future',
    ]);
    expect(missing).toEqual(['kimi-k9-future']);
  });

  it('matches catalog ids case-insensitively', () => {
    // MiniMax serves ids with mixed case (MiniMax-M3); the catalog entry must match.
    const missing = diffServedModelsAgainstCatalog('minimax', ['minimax-m3', 'MiniMax-M2.5']);
    expect(missing).toEqual([]);
  });

  it('returns empty for unknown providers and empty/blank ids', () => {
    expect(diffServedModelsAgainstCatalog('no-such-provider', ['x'])).toEqual([]);
    expect(diffServedModelsAgainstCatalog('moonshot', ['', '   '])).toEqual([]);
  });

  it('catalog carries the models this check was added for', () => {
    // Regression anchors: these shipped while the catalog lagged behind.
    expect(getProvider('moonshot')?.models.some(m => m.id === 'kimi-k2.6')).toBe(true);
    const m3 = getProvider('minimax')?.models.find(m => m.id === 'MiniMax-M3');
    expect(m3).toBeDefined();
    expect(m3?.supportsVision).toBe(true);
    expect(getProvider('minimax')?.defaultModel).toBe('MiniMax-M3');
  });
});
