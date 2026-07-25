import { z } from 'zod';

export const AGENT_SUMMARY_MAX_CHARS = 2_000;
export const AGENT_FINDINGS_MAX_ITEMS = 10;
export const AGENT_FINDING_MAX_CHARS = 500;
export const AGENT_ARTIFACTS_MAX_ITEMS = 20;

const AgentExecutionDraftSchema = z.object({
  status: z.enum(['succeeded', 'failed', 'blocked']),
  summary: z.string(),
  key_findings: z.array(z.string()).default([]),
  artifacts: z.array(z.string()).default([]),
  blocker: z.string().optional(),
});

export const AgentExecutionEnvelopeSchema = AgentExecutionDraftSchema.extend({
  transcript_path: z.string().min(1),
});

export type AgentExecutionDraft = z.infer<typeof AgentExecutionDraftSchema>;
export type AgentExecutionEnvelope = z.infer<typeof AgentExecutionEnvelopeSchema>;

function truncate(value: string, maxChars: number): string {
  const chars = Array.from(value.trim());
  if (chars.length <= maxChars) return chars.join('');
  return `${chars.slice(0, Math.max(0, maxChars - 1)).join('')}…`;
}

/** Validate a model-produced draft and enforce the runtime-owned size limits. */
export function normalizeAgentExecutionEnvelope(
  input: unknown,
  transcriptPath: string,
): AgentExecutionEnvelope {
  const parsed = AgentExecutionDraftSchema.parse(input);
  return AgentExecutionEnvelopeSchema.parse({
    ...parsed,
    summary: truncate(parsed.summary, AGENT_SUMMARY_MAX_CHARS),
    key_findings: parsed.key_findings
      .slice(0, AGENT_FINDINGS_MAX_ITEMS)
      .map(finding => truncate(finding, AGENT_FINDING_MAX_CHARS)),
    artifacts: parsed.artifacts.slice(0, AGENT_ARTIFACTS_MAX_ITEMS),
    ...(parsed.blocker ? { blocker: truncate(parsed.blocker, AGENT_SUMMARY_MAX_CHARS) } : {}),
    transcript_path: transcriptPath,
  });
}

/** Construct an honest terminal failure without asking the model to narrate it. */
export function createAgentFailureEnvelope(
  transcriptPath: string,
  summary: string,
  blocker: string,
  status: 'failed' | 'blocked' = 'failed',
): AgentExecutionEnvelope {
  return normalizeAgentExecutionEnvelope({
    status,
    summary,
    key_findings: [],
    artifacts: [],
    blocker,
  }, transcriptPath);
}
