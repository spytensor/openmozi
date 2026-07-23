import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { PassThrough } from 'node:stream';
import { WorkerLaunchRequestSchema } from './adapter.js';
import { ClaudeCodeWorkerAdapter } from './claude-code-adapter.js';

const hoisted = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  calls: [] as Array<{
    command: string;
    args: string[];
    options?: { cwd?: string; env?: Record<string, string>; stdio?: string[] };
  }>,
  responses: [] as Array<{
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    stayOpen?: boolean;
  }>,
  children: [] as MockChild[],
}));

vi.mock('node:child_process', () => ({
  spawn: hoisted.spawnMock,
}));

class MockChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  stdinChunks: Buffer[] = [];
  pid = 40001;
  closeOnKill = true;
  constructor() {
    super();
    this.stdin.on('data', chunk => this.stdinChunks.push(Buffer.from(chunk)));
  }
  readonly kill = vi.fn((_signal?: NodeJS.Signals) => {
    if (!this.closeOnKill) return true;
    queueMicrotask(() => {
      this.stdout.end();
      this.stderr.end();
      this.emit('close', 0);
    });
    return true;
  });
}

function makeRequest(overrides: Partial<ReturnType<typeof WorkerLaunchRequestSchema.parse>> = {}) {
  return WorkerLaunchRequestSchema.parse({
    job_id: 'job-1',
    tenant_id: 'default',
    task: {
      task_id: 'task-1',
      objective: 'Inspect the repo and summarize the change.',
      done_criteria: 'Summary returned',
      constraints: {
        token_budget: 1000,
        timeout_seconds: 30,
        permission_level: 'L1_READ_WRITE',
        allowed_tools: ['filesystem'],
        forbidden_paths: [],
      },
      hints: {
        complexity: 'low',
        type: 'general',
        needs_tool_calling: false,
        estimated_tokens: 200,
      },
    },
    system_prompt: 'You are a controlled worker.',
    transport: 'stdio',
    adapter_config: {
      adapter: 'claude_code',
      transport: 'stdio',
      model: 'claude-sonnet-4-6',
      env: { CUSTOM_ENV: '1' },
    },
    metadata: {},
    ...overrides,
  });
}

describe('workers/claude-code-adapter', () => {
  const cleanupDirs = new Set<string>();

  beforeEach(() => {
    hoisted.calls.length = 0;
    hoisted.responses.length = 0;
    hoisted.children.length = 0;
    hoisted.spawnMock.mockReset();
    hoisted.spawnMock.mockImplementation(
      (command: string, args: string[], options?: { cwd?: string; env?: Record<string, string>; stdio?: string[] }) => {
        const child = new MockChild();
        child.pid = 40000 + hoisted.children.length + 1;
        hoisted.calls.push({ command, args: [...args], options });
        hoisted.children.push(child);

        const response = hoisted.responses.shift() ?? {
          stdout: '{"result":"Finished task successfully"}\n',
          stderr: '',
          exitCode: 0,
        };

        if (!response.stayOpen) {
          queueMicrotask(() => {
            if (response.stdout) child.stdout.write(response.stdout);
            child.stdout.end();
            if (response.stderr) child.stderr.write(response.stderr);
            child.stderr.end();
            child.emit('close', response.exitCode ?? 0);
          });
        }

        return child;
      },
    );
  });

  afterEach(() => {
    for (const dir of cleanupDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    cleanupDirs.clear();
  });

  it('launches Claude Code via the generic adapter contract and collects a success result', async () => {
    const adapter = new ClaudeCodeWorkerAdapter();
    const launch = await adapter.launch(makeRequest());

    expect(hoisted.calls).toHaveLength(1);
    expect(hoisted.calls[0]?.command).toBe('claude');
    expect(hoisted.calls[0]?.args).toContain('-p');
    expect(hoisted.calls[0]?.args).toContain('--output-format');
    expect(hoisted.calls[0]?.args).toContain('json');
    expect(hoisted.calls[0]?.args).toContain('--model');
    expect(hoisted.calls[0]?.args).toContain('claude-sonnet-4-6');
    expect(hoisted.calls[0]?.args).toContain('--append-system-prompt');
    const systemPromptIndex = hoisted.calls[0]!.args.indexOf('--append-system-prompt');
    expect(hoisted.calls[0]?.args[systemPromptIndex + 1]).toBe('You are a controlled worker.');
    expect(hoisted.calls[0]?.args.join(' ')).toContain('Task ID: task-1');

    const status = await adapter.poll(launch.handle);
    const result = await adapter.collectResult(launch.handle);

    expect(status.state).toBe('completed');
    expect(result.envelope.status).toBe('success');
    expect(result.envelope.summary).toContain('Finished task successfully');
    expect(result.runtime_label).toBe('claude-sonnet-4-6');
    expect(hoisted.calls[0]?.options?.env?.CUSTOM_ENV).toBe('1');
    await expect(adapter.poll(launch.handle)).rejects.toThrow('Unknown worker handle');
  });

  it('uses the MCP transport to append config flags and return config artifacts', async () => {
    const adapter = new ClaudeCodeWorkerAdapter();
    const launch = await adapter.launch(makeRequest({
      transport: 'mcp',
      adapter_config: {
        adapter: 'claude_code',
        transport: 'mcp',
        model: 'claude-sonnet-4-6',
        env: { CUSTOM_ENV: '1' },
        transport_options: {
          mcp: {
            strict: true,
            servers: {
              filesystem: {
                command: 'npx',
                args: ['-y', '@anthropic/mcp-filesystem-server', '/repo'],
              },
            },
          },
        },
      },
    }));
    const result = await adapter.collectResult(launch.handle);

    expect(adapter.supportsTransport('mcp')).toBe(true);
    expect(hoisted.calls[0]?.args).toContain('--mcp-config');
    expect(hoisted.calls[0]?.args).toContain('--strict-mcp-config');
    expect(result.artifacts).toHaveLength(1);
    cleanupDirs.add(dirname(result.artifacts[0]!));
    expect(launch.handle.metadata).toMatchObject({
      transport: 'mcp',
      mcp_generated: true,
      mcp_server_ids: ['filesystem'],
      mcp_strict: true,
    });
  });

  it('delivers a large managed task through stdin before MCP transport flags', async () => {
    const objective = '中'.repeat(30_000);
    const adapter = new ClaudeCodeWorkerAdapter();
    const launch = await adapter.launch(makeRequest({
      task: { ...makeRequest().task, objective },
      transport: 'mcp',
      adapter_config: {
        adapter: 'claude_code', transport: 'mcp', env: {},
        transport_options: {
          mcp: { servers: { fixture: { command: 'node', args: ['fixture.js'] } } },
        },
      },
    }));
    await adapter.collectResult(launch.handle);

    const call = hoisted.calls[0]!;
    expect(call.options?.stdio?.[0]).toBe('pipe');
    expect(call.args.some(arg => arg.includes(objective))).toBe(false);
    expect(call.args).toContain('--mcp-config');
    expect(Buffer.concat(hoisted.children[0]!.stdinChunks).toString()).toContain(objective);
  });

  it('fails when stdin delivery errors even if the child exits zero', async () => {
    hoisted.responses.push({ stayOpen: true });
    const objective = 'x'.repeat(65_536);
    const adapter = new ClaudeCodeWorkerAdapter();
    const launch = await adapter.launch(makeRequest({ task: { ...makeRequest().task, objective } }));
    const child = hoisted.children[0]!;
    const error = Object.assign(new Error('closed pipe'), { code: 'EPIPE' });
    child.stdin.emit('error', error);
    child.emit('close', 0);

    const result = await adapter.collectResult(launch.handle);
    expect(result.envelope.status).toBe('failed');
    expect(result.envelope.summary).toContain('CLI prompt delivery failed on stdin (EPIPE)');
  });

  it('kills and settles a worker whose stdin fails while apparent-success stdout stays open', async () => {
    vi.useFakeTimers();
    try {
      hoisted.responses.push({ stayOpen: true });
      const adapter = new ClaudeCodeWorkerAdapter();
      const launch = await adapter.launch(makeRequest({
        task: { ...makeRequest().task, objective: 'x'.repeat(65_536) },
      }));
      const child = hoisted.children[0]!;
      child.closeOnKill = false;
      child.stdout.write('{"result":"Finished task successfully"}\n');
      child.stdin.emit('error', Object.assign(new Error('closed pipe'), { code: 'EPIPE' }));
      child.emit('error', new Error('kill EPERM'));

      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      await vi.advanceTimersByTimeAsync(2_000);
      const result = await adapter.collectResult(launch.handle);

      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      expect(result.envelope.status).toBe('failed');
      expect(result.envelope.summary).toContain('CLI prompt delivery failed on stdin (EPIPE)');
      expect(result.envelope.summary).not.toContain('kill EPERM');
      expect(result.envelope.summary).not.toContain('Finished task successfully');
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails clearly before spawn when a system prompt exceeds the argv entry budget', async () => {
    const adapter = new ClaudeCodeWorkerAdapter();
    await expect(adapter.launch(makeRequest({
      system_prompt: 's'.repeat(131_072),
    }))).rejects.toThrow('CLI spawn budget exceeded for argv');
    expect(hoisted.spawnMock).not.toHaveBeenCalled();
  });

  it('cancels a running Claude worker and returns a cancelled envelope', async () => {
    hoisted.responses.push({ stayOpen: true });

    const adapter = new ClaudeCodeWorkerAdapter();
    const launch = await adapter.launch(makeRequest());

    await adapter.cancel(launch.handle, 'Cancelled by verifier');
    const result = await adapter.collectResult(launch.handle);

    expect(hoisted.children[0]?.kill).toHaveBeenCalledWith('SIGTERM');
    expect(result.envelope.status).toBe('cancelled');
    expect(result.envelope.summary).toContain('Cancelled by verifier');
  });

  it('turns non-zero exits into failed envelopes with propagated stderr', async () => {
    hoisted.responses.push({
      stdout: '',
      stderr: 'permission denied',
      exitCode: 1,
    });

    const adapter = new ClaudeCodeWorkerAdapter();
    const launch = await adapter.launch(makeRequest());
    const result = await adapter.collectResult(launch.handle);

    expect(result.envelope.status).toBe('failed');
    expect(result.envelope.summary).toContain('permission denied');
    expect(result.stderr).toContain('permission denied');
  });
});
