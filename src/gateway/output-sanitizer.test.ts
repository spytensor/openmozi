import { describe, expect, it } from 'vitest';
import { sanitizeVisibleOutput } from './output-sanitizer.js';

describe('gateway/output-sanitizer', () => {
  it('strips DeepSeek DSML tool-call markup from visible output', () => {
    const leaked =
      'Working. <|DSML|tool_calls> <|DSML|invoke name="shell_exec"> ' +
      '<|DSML|parameter name="command" string="true">python build_mozi_deck.py';

    const cleaned = sanitizeVisibleOutput(leaked);

    expect(cleaned).toBe('Working.');
    expect(cleaned).not.toContain('<|DSML|');
    expect(cleaned).not.toContain('shell_exec');
  });
});
