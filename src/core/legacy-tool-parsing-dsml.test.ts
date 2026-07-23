import { describe, it, expect } from 'vitest';
import {
  extractLegacyToolCallsFromText,
  hasDsmlToolCallMarkup,
  stripDsmlToolCallMarkup,
} from './legacy-tool-parsing.js';

describe('DSML tool-call recovery', () => {
  const dsml =
    '<|DSML|tool_calls>' +
    '<|DSML|invoke name="web_fetch">' +
    '<|DSML|parameter name="url" string="true">https://www.langchain.com/resources/ai-agent-frameworks</|DSML|parameter>' +
    '<|DSML|parameter name="max_chars" string="false">15000</|DSML|parameter>' +
    '</|DSML|invoke>' +
    '<|DSML|invoke name="web_fetch">' +
    '<|DSML|parameter name="url" string="true">https://deepchecks.com/best-ai-agent-frameworks/</|DSML|parameter>' +
    '</|DSML|invoke>' +
    '</|DSML|tool_calls>';

  it('detects DSML markup', () => {
    expect(hasDsmlToolCallMarkup(dsml)).toBe(true);
    expect(hasDsmlToolCallMarkup('normal answer text')).toBe(false);
  });

  it('parses every DSML invoke into a real tool call with coerced args', () => {
    const result = extractLegacyToolCallsFromText(`Sure. ${dsml}`);
    expect(result).not.toBeNull();
    expect(result!.toolCalls).toHaveLength(2);

    const first = result!.toolCalls[0];
    expect(first.function.name).toBe('web_fetch');
    const args = JSON.parse(first.function.arguments);
    // string="true" stays a string; string="false" is coerced to a number.
    expect(args.url).toBe('https://www.langchain.com/resources/ai-agent-frameworks');
    expect(args.max_chars).toBe(15000);

    expect(result!.toolCalls[1].function.name).toBe('web_fetch');
    // The visible content is cleaned of all DSML markup.
    expect(result!.cleanedContent).toBe('Sure.');
  });

  it('strips DSML markup from visible text', () => {
    expect(stripDsmlToolCallMarkup(`Answer ${dsml}`)).toBe('Answer');
  });

  // Regression: DeepSeek emits its delimiters with FULLWIDTH pipes (｜ U+FF5C).
  // A live leak of exactly this shape sailed past the ASCII-only patterns and
  // rendered as raw garbage in the chat while the intended shell command never ran.
  describe('fullwidth-pipe variant (production leak)', () => {
    const fullwidth =
      '<｜DSML｜tool_calls>' +
      '<｜DSML｜invoke name="shell_exec">' +
      '<｜DSML｜parameter name="command" string="true">cd /data/output && python3 fill_tax_data.py</｜DSML｜parameter>' +
      '</｜DSML｜invoke>' +
      '</｜DSML｜tool_calls>';

    it('detects fullwidth DSML markup', () => {
      expect(hasDsmlToolCallMarkup(fullwidth)).toBe(true);
    });

    it('recovers the intended tool call', () => {
      const result = extractLegacyToolCallsFromText(`继续执行。${fullwidth}`);
      expect(result).not.toBeNull();
      expect(result!.toolCalls).toHaveLength(1);
      expect(result!.toolCalls[0].function.name).toBe('shell_exec');
      const args = JSON.parse(result!.toolCalls[0].function.arguments);
      expect(args.command).toBe('cd /data/output && python3 fill_tax_data.py');
      expect(result!.cleanedContent).toBe('继续执行。');
    });

    it('strips fullwidth DSML from visible text', () => {
      expect(stripDsmlToolCallMarkup(`Answer ${fullwidth}`)).toBe('Answer');
    });
  });
});
