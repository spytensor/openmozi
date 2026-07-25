import { describe, expect, it } from 'vitest';
import {
  AGENT_FINDINGS_MAX_ITEMS,
  AGENT_FINDING_MAX_CHARS,
  AGENT_SUMMARY_MAX_CHARS,
  AgentExecutionEnvelopeSchema,
  normalizeAgentExecutionEnvelope,
} from './execution-envelope.js';

describe('agent execution envelope', () => {
  it('validates status and enforces summary/finding limits with Unicode-safe truncation', () => {
    const envelope = normalizeAgentExecutionEnvelope({
      status: 'succeeded',
      summary: '墨'.repeat(AGENT_SUMMARY_MAX_CHARS + 20),
      key_findings: Array.from(
        { length: AGENT_FINDINGS_MAX_ITEMS + 3 },
        (_, index) => `${index}:${'见'.repeat(AGENT_FINDING_MAX_CHARS + 10)}`,
      ),
      artifacts: [],
    }, '/output/agents/a/run-1/transcript.md');

    expect(AgentExecutionEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(Array.from(envelope.summary)).toHaveLength(AGENT_SUMMARY_MAX_CHARS);
    expect(envelope.key_findings).toHaveLength(AGENT_FINDINGS_MAX_ITEMS);
    expect(Array.from(envelope.key_findings[0] ?? '')).toHaveLength(AGENT_FINDING_MAX_CHARS);
  });

  it('rejects legacy or ambiguous statuses', () => {
    expect(() => normalizeAgentExecutionEnvelope({
      status: 'success',
      summary: 'no',
      key_findings: [],
      artifacts: [],
    }, '/tmp/transcript.md')).toThrow();
  });
});
