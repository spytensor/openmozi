import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { LoadedAgentDefinition } from './definition-loader.js';
import { delegateToAgent } from './delegate-runner.js';
import { AGENT_SUMMARY_MAX_CHARS, AgentExecutionEnvelopeSchema } from './execution-envelope.js';

let root = '';

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

describe('delegate agent real model integration', () => {
  it('runs gpt-4.1-mini end to end and archives its validated envelope', async (ctx) => {
    if (!process.env.OPENAI_API_KEY) {
      ctx.skip();
      return;
    }
    root = mkdtempSync(join(tmpdir(), 'mozi-agent-real-'));
    const bundledSkillsDir = join(root, 'skills');
    const workspaceSkillsDir = join(root, 'workspace-skills');
    mkdirSync(bundledSkillsDir, { recursive: true });
    mkdirSync(workspaceSkillsDir, { recursive: true });
    const definition: LoadedAgentDefinition = {
      id: 'workspace:tiny-real',
      name: 'tiny-real',
      description: 'Returns one tiny result.',
      model: 'openai/gpt-4.1-mini',
      skills: [],
      tools: [],
      permission_level: 'L0_READ_ONLY',
      persona: 'Follow the execution contract exactly. Return the smallest valid JSON result.',
      content: '',
      filePath: join(root, 'AGENT.md'),
      directoryName: 'tiny-real',
      source: 'workspace',
      enabled: true,
      status: 'ready',
      missingSkills: [],
      frontmatter: {
        name: 'tiny-real',
        description: 'Returns one tiny result.',
        model: 'openai/gpt-4.1-mini',
        skills: [],
        tools: [],
        permission_level: 'L0_READ_ONLY',
      },
    };

    const envelope = await delegateToAgent({
      agent: 'tiny-real',
      brief: 'Succeed with summary "ok", no findings, and no artifacts.',
      definitions: [definition],
      outputDir: join(root, 'output'),
      bundledSkillsDir,
      workspaceSkillsDir,
      registeredTools: [],
      timeoutMs: 30_000,
      maxRounds: 1,
      maxTokens: 50,
    });

    expect(AgentExecutionEnvelopeSchema.parse(envelope).status).toBe('succeeded');
    expect(Array.from(envelope.summary).length).toBeLessThanOrEqual(AGENT_SUMMARY_MAX_CHARS);
    expect(existsSync(envelope.transcript_path)).toBe(true);
    expect(readFileSync(envelope.transcript_path, 'utf-8')).toContain('## Final Envelope');
  });
});
