import { describe, it, expect } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';

const WORKER_PATH = resolve(import.meta.dirname ?? '.', '../../dist/agents/subagent-worker.js');

/** Fork the worker with minimal env vars and wait until it is ready */
function spawnWorker(): ChildProcess {
  return fork(WORKER_PATH, [], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    env: {
      ...process.env,
      MOZI_AGENT_ID: 'test-agent',
      MOZI_PROCESS_ID: 'test-proc-1',
      MOZI_SYSTEM_PROMPT: 'You are a test agent.',
      MOZI_TOOLS_ALLOWED: '[]',
      MOZI_PERMISSION_LEVEL: 'L0_READ_ONLY',
    },
  });
}

/** Wait until the child process is fully spawned and producing output */
function waitForReady(child: ChildProcess, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(), timeoutMs); // fallback
    const onData = () => {
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      resolve();
    };
    child.stdout?.on('data', onData);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

/** Read lines from stdout, collecting parsed JSON objects */
function collectStdout(child: ChildProcess): { lines: unknown[] } {
  const result = { lines: [] as unknown[] };
  let buffer = '';
  child.stdout?.on('data', (data: Buffer) => {
    buffer += data.toString();
    const parts = buffer.split('\n');
    buffer = parts.pop() || '';
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      try {
        result.lines.push(JSON.parse(trimmed));
      } catch {
        // skip non-JSON
      }
    }
  });
  return result;
}

describe('subagent-worker', () => {
  it('responds to ping with pong', async () => {
    const child = spawnWorker();
    const output = collectStdout(child);

    // Wait for worker to be fully ready (first stdout output)
    await waitForReady(child);

    // Send ping
    child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }) + '\n');

    // Wait for response
    await new Promise((r) => setTimeout(r, 2000));

    // Find the pong response (skip heartbeats)
    const pongMsg = output.lines.find(
      (msg: unknown) => (msg as Record<string, unknown>).id === 1
    ) as Record<string, unknown> | undefined;

    expect(pongMsg).toBeDefined();
    expect(pongMsg?.jsonrpc).toBe('2.0');
    expect(pongMsg?.result).toBe('pong');

    child.kill('SIGTERM');
    await new Promise((r) => child.on('exit', r));
  }, 15_000);

  it('sends heartbeat within 5 seconds', async () => {
    const child = spawnWorker();
    const output = collectStdout(child);

    // Wait for worker to be ready, then wait for heartbeat interval
    await waitForReady(child);
    await new Promise((r) => setTimeout(r, 5000));

    const heartbeats = output.lines.filter(
      (msg: unknown) => (msg as Record<string, unknown>).method === 'heartbeat'
    );

    expect(heartbeats.length).toBeGreaterThanOrEqual(1);

    child.kill('SIGTERM');
    await new Promise((r) => child.on('exit', r));
  }, 15_000);

  it('exits on SIGTERM', async () => {
    const child = spawnWorker();

    // Wait for worker to be fully ready before sending signal
    await waitForReady(child);

    const exitPromise = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child.on('exit', (code, signal) => resolve({ code, signal }));
    });

    child.kill('SIGTERM');

    const { code, signal } = await exitPromise;
    // On SIGTERM: either exits with code 0 (handler fires) or null with signal SIGTERM
    expect(code === 0 || signal === 'SIGTERM').toBe(true);
  }, 15_000);
});
