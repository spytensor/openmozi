import { describe, it, expect } from 'vitest';
import { compress } from './running-summary.js';
import { loadConfig } from '../config/index.js';
import type { ChatMessage } from './llm.js';

// Keep base config initialized for deterministic defaults.
loadConfig();

describe('core/running-summary', () => {
  it('does not compress when below threshold', async () => {
    const turns: ChatMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ];

    const result = await compress(turns, 5, 4);
    expect(result.summary).toBe('');
    expect(result.kept_turns).toEqual(turns);
    expect(result.summary_tokens).toBe(0);
  });
});
