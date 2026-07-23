import { describe, expect, it } from 'vitest';
import { rememberTool } from './memory-tools.js';
import { STEP_RESULT_PERSISTENCE_NOTE } from '../core/plan-grounding.js';

/**
 * Prompt-contract tests for the memory-worthiness boundary.
 *
 * Confirmed incident (2026-07-18/19): plan steps stored arithmetic
 * intermediates ("第一步结果 8+13+21+34=76…") and bond-market research
 * findings into the user's long-term memory via `remember`, because the tool
 * description said "key facts" without defining whose facts, and step turns
 * were never told the runtime already persists their results. These tests pin
 * the two prompt clauses that close that hole; loosening them should fail CI.
 */
describe('tools/memory-tools prompt contract', () => {
  it('remember description defines memory as user biography, not task output', () => {
    const description = rememberTool.function.description;
    // Positive definition: what memory IS.
    expect(description).toContain('biography');
    expect(description).toContain('the user disclosed');
    // The memory-worthiness test the Brain must apply.
    expect(description).toContain('NEW conversation next week');
    // Explicit exclusions covering both observed failure shapes.
    expect(description).toContain('step results');
    expect(description).toContain('research findings');
    expect(description).toContain('analysis conclusions');
    // Points the Brain at the correct persistence channel.
    expect(description).toContain('the runtime persists task results separately');
  });

  it('step persistence note tells steps the runtime owns result persistence', () => {
    expect(STEP_RESULT_PERSISTENCE_NOTE).toContain('Persistence is handled by the runtime');
    expect(STEP_RESULT_PERSISTENCE_NOTE).toContain('passed verbatim to any dependent step');
    expect(STEP_RESULT_PERSISTENCE_NOTE).toContain('Do NOT use the remember');
    expect(STEP_RESULT_PERSISTENCE_NOTE).toContain('never task output');
  });
});
