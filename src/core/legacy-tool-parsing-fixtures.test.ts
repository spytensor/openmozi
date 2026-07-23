/**
 * Canonical fixture matrix for legacy tool-call parsing.
 *
 * This file is the authoritative variant table for future provider additions.
 * It is ADDITIVE — do not delete the existing focused tests in:
 *   - legacy-tool-parsing-dsml.test.ts   (DSML unit tests + fullwidth regression)
 *   - llm-legacy-toolcall-fallback.test.ts (llm adapter integration tests)
 *
 * Coverage here: every text-protocol variant that extractLegacyToolCallsFromText
 * must handle, plus the no-tools suppression contract.
 */

import { describe, it, expect } from 'vitest';
import {
  extractLegacyToolCallsFromText,
  hasDsmlToolCallMarkup,
  stripDsmlToolCallMarkup,
} from './legacy-tool-parsing.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const ASCII_DSML =
  '<|DSML|tool_calls>' +
  '<|DSML|invoke name="shell_exec">' +
  '<|DSML|parameter name="command" string="true">echo hello</|DSML|parameter>' +
  '<|DSML|parameter name="timeout" string="false">30</|DSML|parameter>' +
  '</|DSML|invoke>' +
  '</|DSML|tool_calls>';

const FULLWIDTH_DSML =
  '<｜DSML｜tool_calls>' +
  '<｜DSML｜invoke name="shell_exec">' +
  '<｜DSML｜parameter name="command" string="true">echo hello</｜DSML｜parameter>' +
  '<｜DSML｜parameter name="timeout" string="false">30</｜DSML｜parameter>' +
  '</｜DSML｜invoke>' +
  '</｜DSML｜tool_calls>';

const DOUBLED_PIPE_DSML =
  '<｜｜DSML｜｜tool_calls>' +
  '<｜｜DSML｜｜invoke name="shell_exec">' +
  '<｜｜DSML｜｜parameter name="command" string="true">echo hello</｜｜DSML｜｜parameter>' +
  '<｜｜DSML｜｜parameter name="timeout" string="false">30</｜｜DSML｜｜parameter>' +
  '</｜｜DSML｜｜invoke>' +
  '</｜｜DSML｜｜tool_calls>';

// Unclosed invoke tag — truncated mid-stream by token budget
const TRUNCATED_DSML_UNCLOSED =
  '<|DSML|tool_calls>' +
  '<|DSML|invoke name="shell_exec">' +
  '<|DSML|parameter name="command" string="true">echo hello';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function parseArgs(toolCall: { function: { arguments: string } }): Record<string, unknown> {
  return JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Variant matrix
// ---------------------------------------------------------------------------

describe('legacy-tool-parsing fixture matrix', () => {

  // ---- [TOOL_CALL] bracket protocol ----------------------------------------

  describe('[TOOL_CALL] bracket protocol', () => {
    it('parses JSON-object tool name', () => {
      const input = '[TOOL_CALL] {"tool": "web_search", "args": {"query": "test"}} [/TOOL_CALL]';
      const result = extractLegacyToolCallsFromText(input);
      expect(result).not.toBeNull();
      expect(result!.toolCalls).toHaveLength(1);
      expect(result!.toolCalls[0].function.name).toBe('web_search');
      expect(parseArgs(result!.toolCalls[0]).query).toBe('test');
    });

    it('parses arrow-notation tool name', () => {
      const input = '[TOOL_CALL] {tool => "web_search", args => { --query "arrow test" }} [/TOOL_CALL]';
      const result = extractLegacyToolCallsFromText(input);
      expect(result).not.toBeNull();
      expect(result!.toolCalls[0].function.name).toBe('web_search');
      expect(parseArgs(result!.toolCalls[0]).query).toBe('arrow test');
    });

    it('strips [TOOL_CALL] markup from visible text', () => {
      const input = 'Here is my plan:\n[TOOL_CALL] {"tool": "web_search", "args": {"query": "q"}} [/TOOL_CALL]\nDone.';
      const result = extractLegacyToolCallsFromText(input);
      expect(result!.cleanedContent).not.toContain('[TOOL_CALL]');
      expect(result!.cleanedContent).toContain('Here is my plan');
    });

    it('returns null for [TOOL_CALL] with no recognisable tool name', () => {
      const input = '[TOOL_CALL] {"garbage": true} [/TOOL_CALL]';
      // parseLegacyToolCallBlock returns null, so toolCalls stays empty → returns null
      const result = extractLegacyToolCallsFromText(input);
      expect(result).toBeNull();
    });
  });

  // ---- <function=name> protocol --------------------------------------------

  describe('<function=name> protocol', () => {
    it('parses <function=name> with JSON args', () => {
      const input = '<function=web_search>{"query": "fn test", "max_results": 5}</function>';
      const result = extractLegacyToolCallsFromText(input);
      expect(result).not.toBeNull();
      expect(result!.toolCalls[0].function.name).toBe('web_search');
      const args = parseArgs(result!.toolCalls[0]);
      expect(args.query).toBe('fn test');
      expect(args.max_results).toBe(5);
    });

    it('strips <function=…> markup from visible text', () => {
      const input = 'Searching now.\n<function=web_search>{"query": "q"}</function>';
      const result = extractLegacyToolCallsFromText(input);
      expect(result!.cleanedContent).not.toContain('<function=');
      expect(result!.cleanedContent).toContain('Searching now');
    });

    it('parses multiple <function=…> calls in one response', () => {
      const input =
        '<function=web_search>{"query": "a"}</function>' +
        '<function=web_fetch>{"url": "https://example.com"}</function>';
      const result = extractLegacyToolCallsFromText(input);
      expect(result!.toolCalls).toHaveLength(2);
      expect(result!.toolCalls[0].function.name).toBe('web_search');
      expect(result!.toolCalls[1].function.name).toBe('web_fetch');
    });
  });

  // ---- Markdown JSON code block protocol -----------------------------------

  describe('markdown JSON code block protocol', () => {
    it('parses ```json block with "tool" field', () => {
      const input = '```json\n{"tool": "create_file", "args": {"path": "/tmp/x.txt", "content": "hi"}}\n```';
      const result = extractLegacyToolCallsFromText(input);
      expect(result).not.toBeNull();
      expect(result!.toolCalls[0].function.name).toBe('create_file');
    });

    it('parses ```json block with "name" field', () => {
      const input = '```json\n{"name": "shell_exec", "arguments": {"command": "ls"}}\n```';
      const result = extractLegacyToolCallsFromText(input);
      expect(result).not.toBeNull();
      expect(result!.toolCalls[0].function.name).toBe('shell_exec');
    });

    it('does NOT parse a plain data JSON block (no tool/name/function key)', () => {
      const input = '```json\n{"users": [{"id": 1}]}\n```';
      const result = extractLegacyToolCallsFromText(input);
      expect(result).toBeNull();
    });
  });

  // ---- DSML ASCII pipes ---------------------------------------------------

  describe('DSML ASCII pipe variant', () => {
    it('detects ASCII DSML markup', () => {
      expect(hasDsmlToolCallMarkup(ASCII_DSML)).toBe(true);
      expect(hasDsmlToolCallMarkup('normal text')).toBe(false);
    });

    it('parses ASCII DSML invoke into a tool call with coerced args', () => {
      const result = extractLegacyToolCallsFromText(`Run it. ${ASCII_DSML}`);
      expect(result).not.toBeNull();
      expect(result!.toolCalls).toHaveLength(1);
      expect(result!.toolCalls[0].function.name).toBe('shell_exec');
      const args = parseArgs(result!.toolCalls[0]);
      expect(args.command).toBe('echo hello');
      expect(args.timeout).toBe(30); // string="false" → coerced number
    });

    it('strips ASCII DSML from visible text', () => {
      const cleaned = stripDsmlToolCallMarkup(`Before. ${ASCII_DSML} After.`);
      expect(cleaned).not.toMatch(/<[|]/);
      expect(cleaned).toContain('Before');
      expect(cleaned).toContain('After');
    });
  });

  // ---- DSML fullwidth pipes (｜ U+FF5C) -----------------------------------

  describe('DSML fullwidth pipe variant (U+FF5C)', () => {
    it('detects fullwidth DSML markup', () => {
      expect(hasDsmlToolCallMarkup(FULLWIDTH_DSML)).toBe(true);
    });

    it('parses fullwidth DSML invoke with coerced args', () => {
      const result = extractLegacyToolCallsFromText(`继续。${FULLWIDTH_DSML}`);
      expect(result).not.toBeNull();
      expect(result!.toolCalls[0].function.name).toBe('shell_exec');
      const args = parseArgs(result!.toolCalls[0]);
      expect(args.command).toBe('echo hello');
      expect(args.timeout).toBe(30);
      expect(result!.cleanedContent).toBe('继续。');
    });

    it('strips fullwidth DSML from visible text', () => {
      const cleaned = stripDsmlToolCallMarkup(`Answer. ${FULLWIDTH_DSML}`);
      expect(cleaned).not.toContain('｜DSML｜');
      expect(cleaned).toContain('Answer');
    });
  });

  // ---- DSML doubled pipes (｜｜) — production regression ------------------

  describe('DSML doubled fullwidth pipe variant (｜｜)', () => {
    it('detects doubled-pipe DSML markup', () => {
      expect(hasDsmlToolCallMarkup(DOUBLED_PIPE_DSML)).toBe(true);
    });

    it('parses doubled-pipe DSML invoke with coerced args', () => {
      const result = extractLegacyToolCallsFromText(`继续。${DOUBLED_PIPE_DSML}`);
      expect(result).not.toBeNull();
      expect(result!.toolCalls[0].function.name).toBe('shell_exec');
      const args = parseArgs(result!.toolCalls[0]);
      expect(args.command).toBe('echo hello');
      expect(args.timeout).toBe(30);
      expect(result!.cleanedContent).toBe('继续。');
    });

    it('strips doubled-pipe DSML from visible text', () => {
      const cleaned = stripDsmlToolCallMarkup(`Answer. ${DOUBLED_PIPE_DSML}`);
      expect(cleaned).not.toContain('DSML');
      expect(cleaned).toContain('Answer');
    });
  });

  // ---- Truncated / unclosed DSML ------------------------------------------

  describe('truncated DSML (unclosed tags)', () => {
    it('detects truncated DSML markup (hasDsmlToolCallMarkup)', () => {
      // Even unclosed, the opening tag is enough to detect it
      expect(hasDsmlToolCallMarkup(TRUNCATED_DSML_UNCLOSED)).toBe(true);
    });

    it('tool-capable surface: strips truncated DSML and returns no parsed calls (notice suppressed)', () => {
      // The invoke regex requires a closing tag, so parseDsmlToolCalls returns [].
      // extractLegacyToolCallsFromText strips DSML markup but finds no tool calls → returns null.
      // This means no "tool call ignored" notice leaks as text, and the caller retries.
      const result = extractLegacyToolCallsFromText(TRUNCATED_DSML_UNCLOSED);
      // No complete tool call can be extracted from an unclosed tag
      expect(result).toBeNull();
    });

    it('stripping truncated DSML removes the partial markup from visible text', () => {
      const cleaned = stripDsmlToolCallMarkup(`Before. ${TRUNCATED_DSML_UNCLOSED}`);
      expect(cleaned).not.toContain('<|DSML|');
      // Should not expose raw partial markup to the user
      expect(cleaned).not.toContain('invoke name=');
    });

    it('text-only surface: pure DSML with no surrounding text becomes empty content', () => {
      // Simulates text-only (no-tools) recovery path: if the entire response is
      // DSML markup (nothing left after stripping), the result must be null/empty
      // so the recovery loop retries rather than delivering a blank answer.
      const result = extractLegacyToolCallsFromText(TRUNCATED_DSML_UNCLOSED);
      expect(result).toBeNull();
    });
  });

  // ---- Cross-variant: multiple formats in one response ---------------------

  describe('mixed format in one response', () => {
    it('extracts both a <function=> call and a [TOOL_CALL] block', () => {
      const input =
        'Step 1.\n' +
        '<function=web_search>{"query": "first"}</function>\n' +
        'Step 2.\n' +
        '[TOOL_CALL] {"tool": "write_file", "args": {"path": "/tmp/x", "content": "hi"}} [/TOOL_CALL]';
      const result = extractLegacyToolCallsFromText(input);
      expect(result).not.toBeNull();
      expect(result!.toolCalls).toHaveLength(2);
      expect(result!.toolCalls[0].function.name).toBe('web_search');
      expect(result!.toolCalls[1].function.name).toBe('write_file');
    });
  });

  // ---- No-tools suppression contract ---------------------------------------

  describe('no-tools suppression contract', () => {
    it('DSML in a text-only context: stripDsmlToolCallMarkup leaves no markup artifact', () => {
      // When the LLM adapter is called without tools, the adapter itself is
      // responsible for suppressing DSML (see llm.ts). This test verifies that
      // stripDsmlToolCallMarkup — the building block — removes all markup tokens
      // so no raw DSML fragment reaches the user.
      const result = stripDsmlToolCallMarkup(ASCII_DSML);
      expect(result).toBe('');
    });

    it('partial DSML with surrounding text: strip leaves only the surrounding text', () => {
      const result = stripDsmlToolCallMarkup(`Here is the answer. ${ASCII_DSML} That is it.`);
      expect(result).not.toContain('DSML');
      expect(result).not.toContain('<|');
      expect(result).toContain('Here is the answer');
      expect(result).toContain('That is it');
    });
  });
});
