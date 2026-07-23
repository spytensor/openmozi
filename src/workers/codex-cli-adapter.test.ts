import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkerLaunchRequestSchema } from './adapter.js';
import { CodexCliWorkerAdapter } from './codex-cli-adapter.js';

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
  pid = 41001;
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
        permission_level: 'L2_SHELL_EXEC',
        allowed_tools: ['filesystem', 'shell'],
        forbidden_paths: [],
      },
      hints: {
        complexity: 'low',
        type: 'code',
        needs_tool_calling: true,
        estimated_tokens: 200,
      },
    },
    system_prompt: 'You are a controlled worker.',
    transport: 'stdio',
    adapter_config: {
      adapter: 'codex_cli',
      transport: 'stdio',
      model: 'gpt-5.3-codex',
      env: { CUSTOM_ENV: '1' },
    },
    metadata: {},
    ...overrides,
  });
}

describe('workers/codex-cli-adapter', () => {
  beforeEach(() => {
    hoisted.calls.length = 0;
    hoisted.responses.length = 0;
    hoisted.children.length = 0;
    hoisted.spawnMock.mockReset();
    hoisted.spawnMock.mockImplementation(
      (command: string, args: string[], options?: { cwd?: string; env?: Record<string, string>; stdio?: string[] }) => {
        const child = new MockChild();
        child.pid = 41000 + hoisted.children.length + 1;
        hoisted.calls.push({ command, args: [...args], options });
        hoisted.children.push(child);

        const response = hoisted.responses.shift() ?? {
          stdout: '{"type":"response.output_text.done","text":"Finished task successfully"}\n',
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

  it('launches Codex CLI with workspace-write sandbox for coding agents', async () => {
    const adapter = new CodexCliWorkerAdapter();
    const launch = await adapter.launch(makeRequest());
    const result = await adapter.collectResult(launch.handle);

    expect(hoisted.calls[0]?.command).toBe('codex');
    expect(hoisted.calls[0]?.args).toEqual(expect.arrayContaining([
      'exec',
      '--json',
      '--color',
      'never',
      '--sandbox',
      'workspace-write',
      '--model',
      'gpt-5.3-codex',
      '-c',
    ]));
    expect(hoisted.calls[0]?.args.join(' ')).toContain('developer_instructions=');
    expect(hoisted.calls[0]?.args.join(' ')).toContain('Task ID: task-1');
    expect(result.envelope.status).toBe('success');
    expect(result.envelope.summary).toContain('Finished task successfully');
    expect(result.runtime_label).toBe('gpt-5.3-codex');
    expect(hoisted.calls[0]?.options?.env?.CUSTOM_ENV).toBe('1');
  });

  it('uses read-only sandbox for review-only tasks', async () => {
    const adapter = new CodexCliWorkerAdapter();
    const launch = await adapter.launch(makeRequest({
      task: {
        ...makeRequest().task,
        constraints: {
          ...makeRequest().task.constraints,
          permission_level: 'L0_READ_ONLY',
        },
      },
      adapter_config: {
        adapter: 'codex_cli',
        transport: 'stdio',
        env: {},
      },
    }));
    await adapter.collectResult(launch.handle);

    expect(hoisted.calls[0]?.args).toEqual(expect.arrayContaining([
      '--sandbox',
      'read-only',
    ]));
  });

  it('delivers a large managed task through explicit stdin mode', async () => {
    const objective = '中'.repeat(30_000);
    const adapter = new CodexCliWorkerAdapter();
    const launch = await adapter.launch(makeRequest({ task: { ...makeRequest().task, objective } }));
    await adapter.collectResult(launch.handle);

    const call = hoisted.calls[0]!;
    expect(call.options?.stdio?.[0]).toBe('pipe');
    expect(call.args).toContain('-');
    expect(call.args.some(arg => arg.includes(objective))).toBe(false);
    expect(Buffer.concat(hoisted.children[0]!.stdinChunks).toString()).toContain(objective);
  });

  it('fails when stdin delivery errors even if the child exits zero', async () => {
    hoisted.responses.push({ stayOpen: true });
    const adapter = new CodexCliWorkerAdapter();
    const launch = await adapter.launch(makeRequest({
      task: { ...makeRequest().task, objective: 'x'.repeat(65_536) },
    }));
    const child = hoisted.children[0]!;
    child.stdin.emit('error', Object.assign(new Error('closed pipe'), { code: 'EPIPE' }));
    child.emit('close', 0);

    const result = await adapter.collectResult(launch.handle);
    expect(result.envelope.status).toBe('failed');
    expect(result.envelope.summary).toContain('CLI prompt delivery failed on stdin (EPIPE)');
  });

  it('kills and settles a worker whose stdin fails while apparent-success stdout stays open', async () => {
    vi.useFakeTimers();
    try {
      hoisted.responses.push({ stayOpen: true });
      const adapter = new CodexCliWorkerAdapter();
      const launch = await adapter.launch(makeRequest({
        task: { ...makeRequest().task, objective: 'x'.repeat(65_536) },
      }));
      const child = hoisted.children[0]!;
      child.closeOnKill = false;
      child.stdout.write('{"type":"response.output_text.done","text":"Finished task successfully"}\n');
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
    const adapter = new CodexCliWorkerAdapter();
    await expect(adapter.launch(makeRequest({
      system_prompt: 's'.repeat(131_072),
    }))).rejects.toThrow('CLI spawn budget exceeded for argv');
    expect(hoisted.spawnMock).not.toHaveBeenCalled();
  });

  it('cancels a running Codex worker and returns a cancelled envelope', async () => {
    hoisted.responses.push({ stayOpen: true });

    const adapter = new CodexCliWorkerAdapter();
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
      stderr: 'usage limit reached',
      exitCode: 1,
    });

    const adapter = new CodexCliWorkerAdapter();
    const launch = await adapter.launch(makeRequest());
    const result = await adapter.collectResult(launch.handle);

    expect(result.envelope.status).toBe('failed');
    expect(result.envelope.summary).toContain('usage limit reached');
    expect(result.stderr).toContain('usage limit reached');
  });
});
