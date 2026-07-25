import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChatMessage, ChatOptions, ChatResponse, LLMClient } from '../core/llm.js';
import type { LoadedAgentDefinition } from './definition-loader.js';
import { clampDelegatedPermission, delegateToAgent } from './delegate-runner.js';
import { AgentExecutionEnvelopeSchema } from './execution-envelope.js';
import { on } from '../progress/event-bus.js';
import { writeFileTool } from '../tools/fs-tools.js';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';

const roots: string[] = [];
let dbRoot = '';

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'mozi-agent-runner-'));
  roots.push(root);
  return root;
}

beforeEach(() => {
  dbRoot = setupTestDb().tmpDir;
});

afterEach(() => {
  teardownTestDb(dbRoot);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function definition(overrides: Partial<LoadedAgentDefinition> = {}): LoadedAgentDefinition {
  return {
    id: 'workspace:analyst',
    name: 'analyst',
    description: 'Test analyst',
    skills: [],
    persona: 'Analyze the brief.',
    content: '',
    filePath: '/tmp/analyst/AGENT.md',
    directoryName: 'analyst',
    source: 'workspace',
    enabled: true,
    status: 'ready',
    missingSkills: [],
    frontmatter: {
      name: 'analyst',
      description: 'Test analyst',
      skills: [],
    },
    ...overrides,
  };
}

function response(content: string, toolCalls?: ChatResponse['tool_calls']): ChatResponse {
  return {
    content,
    usage: { input_tokens: 10, output_tokens: 10 },
    model: 'gpt-4.1-mini',
    stop_reason: 'stop',
    tool_calls: toolCalls,
  };
}

function client(
  chat: (messages: ChatMessage[], options?: ChatOptions) => Promise<ChatResponse>,
): LLMClient {
  return {
    provider: 'openai',
    chat,
    chatStream: async function* () {
      throw new Error('unused');
    },
  };
}

function emptySkillDirs(root: string): { bundledSkillsDir: string; workspaceSkillsDir: string } {
  const bundledSkillsDir = join(root, 'skills');
  const workspaceSkillsDir = join(root, 'workspace-skills');
  mkdirSync(bundledSkillsDir, { recursive: true });
  mkdirSync(workspaceSkillsDir, { recursive: true });
  return { bundledSkillsDir, workspaceSkillsDir };
}

describe('delegate agent runner', () => {
  it('archives a valid envelope under agents/<name>/run-N and injects bound plus always skills', async () => {
    const root = tempRoot();
    const outputDir = join(root, 'output');
    const skillDirs = emptySkillDirs(root);
    for (const [name, always, body] of [
      ['bound-skill', false, 'BOUND INSTRUCTIONS'],
      ['system-skill', true, 'ALWAYS INSTRUCTIONS'],
      ['unbound-skill', false, 'MUST NOT APPEAR'],
    ] as const) {
      const dir = join(skillDirs.bundledSkillsDir, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'SKILL.md'),
        `---\nname: ${name}\ndescription: ${name}\nalways: ${always}\n---\n\n${body}\n`,
      );
    }
    let capturedSystem = '';
    const events: Array<{ workerStatus?: string; runDir?: string }> = [];
    const unsubscribe = on(event => {
      if (event.type === 'worker_status') events.push(event);
    });
    try {
      const envelope = await delegateToAgent({
        agent: 'analyst',
        brief: 'Return a compact result.',
        definitions: [definition({ skills: ['bound-skill'] })],
        outputDir,
        ...skillDirs,
        registeredTools: [],
        client: client(async messages => {
          capturedSystem = String(messages[0]?.content ?? '');
          return response(JSON.stringify({
            status: 'succeeded',
            summary: 'done',
            key_findings: ['one'],
            artifacts: [],
          }));
        }),
      });

      expect(AgentExecutionEnvelopeSchema.parse(envelope).status).toBe('succeeded');
      expect(envelope.transcript_path).toBe(join(outputDir, 'agents', 'analyst', 'run-1', 'transcript.md'));
      expect(existsSync(envelope.transcript_path)).toBe(true);
      expect(readFileSync(envelope.transcript_path, 'utf-8')).toContain('Return a compact result.');
      expect(capturedSystem).toContain('BOUND INSTRUCTIONS');
      expect(capturedSystem).toContain('ALWAYS INSTRUCTIONS');
      expect(capturedSystem).not.toContain('MUST NOT APPEAR');
      expect(events.map(event => event.workerStatus)).toEqual(expect.arrayContaining(['launching', 'running', 'completed']));
      expect(events.every(event => event.runDir?.includes('/agents/analyst/run-1'))).toBe(true);
    } finally {
      unsubscribe();
    }
  });

  it('returns classified envelopes for missing and disabled agents', async () => {
    const root = tempRoot();
    const skillDirs = emptySkillDirs(root);
    const missing = await delegateToAgent({
      agent: 'missing',
      brief: 'Do work.',
      definitions: [],
      outputDir: join(root, 'output'),
      ...skillDirs,
      registeredTools: [],
      client: client(async () => response('unused')),
    });
    const disabled = await delegateToAgent({
      agent: 'analyst',
      brief: 'Do work.',
      definitions: [definition({ enabled: false, status: 'disabled' })],
      outputDir: join(root, 'output'),
      ...skillDirs,
      registeredTools: [],
      client: client(async () => response('unused')),
    });

    expect(missing).toMatchObject({ status: 'failed', blocker: 'agent_not_found: missing' });
    expect(disabled).toMatchObject({ status: 'blocked', blocker: 'agent_disabled: analyst' });
    expect(existsSync(missing.transcript_path)).toBe(true);
    expect(existsSync(disabled.transcript_path)).toBe(true);
  });

  it('hard-times out a stalled model call and persists the timeout envelope', async () => {
    const root = tempRoot();
    const envelope = await delegateToAgent({
      agent: 'analyst',
      brief: 'Do work.',
      definitions: [definition()],
      outputDir: join(root, 'output'),
      ...emptySkillDirs(root),
      registeredTools: [],
      timeoutMs: 20,
      client: client(() => new Promise<ChatResponse>(() => {})),
    });

    expect(envelope).toMatchObject({
      status: 'failed',
      summary: 'Agent execution timed out.',
      blocker: 'timeout',
    });
    expect(readFileSync(envelope.transcript_path, 'utf-8')).toContain('"blocker": "timeout"');
  });

  it('executes whitelisted tools with relative writes pinned to the run directory', async () => {
    const root = tempRoot();
    let call = 0;
    const envelope = await delegateToAgent({
      agent: 'analyst',
      brief: 'Create artifact.txt.',
      definitions: [definition({
        tools: ['filesystem'],
        permission_level: 'L1_READ_WRITE',
      })],
      outputDir: join(root, 'output'),
      ...emptySkillDirs(root),
      registeredTools: [writeFileTool],
      client: client(async () => {
        call += 1;
        if (call === 1) {
          return response('', [{
            id: 'write-1',
            type: 'function',
            function: {
              name: 'write_file',
              arguments: JSON.stringify({ path: 'artifact.txt', content: 'artifact body' }),
            },
          }]);
        }
        return response(JSON.stringify({
          status: 'succeeded',
          summary: 'created',
          key_findings: [],
          artifacts: ['artifact.txt'],
        }));
      }),
    });

    const artifactPath = join(root, 'output', 'agents', 'analyst', 'run-1', 'artifact.txt');
    expect(envelope.status, JSON.stringify(envelope)).toBe('succeeded');
    expect(envelope.artifacts).toEqual([artifactPath]);
    expect(readFileSync(artifactPath, 'utf-8')).toBe('artifact body');
    expect(readFileSync(envelope.transcript_path, 'utf-8')).toContain('Round 1 — Tool Results');
  });

  it('rejects a context reference that escapes admitted workspace roots', async () => {
    const root = tempRoot();
    const workspace = join(root, 'workspace');
    const outside = join(root, 'outside.txt');
    mkdirSync(workspace, { recursive: true });
    writeFileSync(outside, 'secret');
    const envelope = await delegateToAgent({
      agent: 'analyst',
      brief: 'Read context.',
      contextRefs: [outside],
      context: { workspaceRootPath: workspace },
      definitions: [definition()],
      outputDir: join(root, 'output'),
      ...emptySkillDirs(root),
      registeredTools: [],
      client: client(async () => response('unused')),
    });

    expect(envelope.status).toBe('blocked');
    expect(envelope.blocker).toContain('context_ref_out_of_scope');
  });

  it('clamps the delegated permission level to declaration, parent, and the L2 ceiling', () => {
    // AGENT.md cannot self-elevate past the delegating turn.
    expect(clampDelegatedPermission('L3_FULL_ACCESS', 'L1_READ_WRITE')).toBe('L1_READ_WRITE');
    // Nor past the hard delegation ceiling, even when the parent is L3.
    expect(clampDelegatedPermission('L3_FULL_ACCESS', 'L3_FULL_ACCESS')).toBe('L2_SHELL_EXEC');
    // A modest declaration is respected as-is.
    expect(clampDelegatedPermission('L1_READ_WRITE', 'L3_FULL_ACCESS')).toBe('L1_READ_WRITE');
    // Missing declaration stays read-only regardless of the parent.
    expect(clampDelegatedPermission(undefined, 'L3_FULL_ACCESS')).toBe('L0_READ_ONLY');
  });
});
