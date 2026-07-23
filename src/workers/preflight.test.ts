import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkerAdapter } from './adapter.js';

const hoisted = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(),
  readClaudeCliCredentialsMock: vi.fn(() => true),
  readCodexCliCredentialsMock: vi.fn(() => true),
  spawnCalls: [] as Array<{
    command: string;
    args: string[];
    options?: { cwd?: string };
  }>,
}));

vi.mock('node:child_process', () => ({
  spawnSync: hoisted.spawnSyncMock,
}));

vi.mock('../core/cli-credentials.js', () => ({
  readClaudeCliCredentials: hoisted.readClaudeCliCredentialsMock,
  readCodexCliCredentials: hoisted.readCodexCliCredentialsMock,
}));

import {
  inspectWorkerAdapterLaneReadiness,
  reportManagedWorkerFailure,
  resetManagedWorkerHealth,
  resolveWorkerExecutionLane,
} from './preflight.js';
import { TaskBriefSchema } from '../agents/protocol.js';
import { resolveProjectRelativePath } from '../runtime/project-root.js';

const fakeAdapter: WorkerAdapter = {
  metadata: {
    id: 'fake_adapter',
    display_name: 'Fake Adapter',
    kind: 'external_cli',
    supported_transports: ['stdio'],
    supported_lanes: ['review', 'code'],
    supported_sandbox_profiles: ['read-only', 'workspace-write'],
  },
  supportsTransport: (transport) => transport === 'stdio',
  launch: async () => {
    throw new Error('not used');
  },
  poll: async () => ({
    state: 'completed',
    started_at: Date.now(),
  }),
  cancel: async () => undefined,
  collectResult: async () => {
    throw new Error('not used');
  },
};

afterEach(() => {
  resetManagedWorkerHealth();
  hoisted.spawnSyncMock.mockReset();
  hoisted.readClaudeCliCredentialsMock.mockReset();
  hoisted.readClaudeCliCredentialsMock.mockReturnValue(true);
  hoisted.readCodexCliCredentialsMock.mockReset();
  hoisted.readCodexCliCredentialsMock.mockReturnValue(true);
  hoisted.spawnCalls.length = 0;
});

describe('workers/preflight', () => {
  it('derives execution lane from task metadata override', () => {
    const lane = resolveWorkerExecutionLane(TaskBriefSchema.parse({
      task_id: 'task-1',
      objective: 'Review the diff',
      constraints: {
        token_budget: 100,
        timeout_seconds: 30,
        permission_level: 'L2_SHELL_EXEC',
        allowed_tools: ['shell'],
        forbidden_paths: [],
      },
      hints: {
        complexity: 'low',
        type: 'code',
        needs_tool_calling: true,
        estimated_tokens: 50,
      },
    }), {
      metadata: {
        lane: 'review',
      },
    });

    expect(lane).toBe('review');
  });

  it('reports a ready worker when lane, sandbox, and command checks pass', async () => {
    const report = await inspectWorkerAdapterLaneReadiness(fakeAdapter, 'code', {
      config: {
        command: 'node',
      },
    });

    expect(report.status).toBe('ready');
    expect(report.lane).toBe('code');
    expect(report.sandbox_profile).toBe('workspace-write');
    expect(report.command_path).toBeTruthy();
  });

  it('blocks lanes that the adapter does not support', async () => {
    const reviewOnlyAdapter: WorkerAdapter = {
      ...fakeAdapter,
      metadata: {
        ...fakeAdapter.metadata,
        id: 'review_only',
        supported_lanes: ['review'],
      },
    };

    const report = await inspectWorkerAdapterLaneReadiness(reviewOnlyAdapter, 'code', {
      config: {
        command: 'node',
      },
    });

    expect(report.status).toBe('blocked');
    expect(report.summary).toContain('does not support lane code');
  });

  it('marks workers down after repeated failures', async () => {
    reportManagedWorkerFailure(fakeAdapter.metadata.id);
    reportManagedWorkerFailure(fakeAdapter.metadata.id);
    reportManagedWorkerFailure(fakeAdapter.metadata.id);

    const report = await inspectWorkerAdapterLaneReadiness(fakeAdapter, 'review', {
      config: {
        command: 'node',
      },
    });

    expect(report.health.status).toBe('down');
    expect(report.status).toBe('blocked');
  });

  it('runs live probes from the configured worker cwd', async () => {
    hoisted.spawnSyncMock.mockImplementation(
      (command: string, args: string[], options?: { cwd?: string }) => {
        hoisted.spawnCalls.push({ command, args: [...args], options });
        return { stdout: '{"result":"OK"}', stderr: '', status: 0 };
      },
    );
    const claudeAdapter: WorkerAdapter = {
      ...fakeAdapter,
      metadata: {
        ...fakeAdapter.metadata,
        id: 'claude_code',
        supported_sandbox_profiles: ['adapter-managed'],
      },
    };

    const report = await inspectWorkerAdapterLaneReadiness(claudeAdapter, 'code', {
      config: {
        command: 'node',
        cwd: 'src/workers',
      },
      liveProbe: true,
    });

    expect(report.live_probe).toMatchObject({ enabled: true, ok: true });
    expect(hoisted.spawnCalls).toHaveLength(1);
    expect(hoisted.spawnCalls[0]?.options?.cwd).toBe(resolveProjectRelativePath('src/workers'));
  });

  it('accepts a Claude CLI session reported by the current auth status command', async () => {
    hoisted.readClaudeCliCredentialsMock.mockReturnValue(false);
    hoisted.spawnSyncMock.mockReturnValue({
      stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }),
      stderr: '',
      status: 0,
    });
    const claudeAdapter: WorkerAdapter = {
      ...fakeAdapter,
      metadata: {
        ...fakeAdapter.metadata,
        id: 'claude_code',
        supported_sandbox_profiles: ['adapter-managed'],
      },
    };

    const report = await inspectWorkerAdapterLaneReadiness(claudeAdapter, 'code', {
      config: { command: 'node' },
    });

    expect(report.status).toBe('ready');
    expect(report.auth_source).toBe('claude auth status');
    expect(hoisted.spawnSyncMock).toHaveBeenCalledWith(
      expect.any(String),
      ['auth', 'status', '--json'],
      expect.objectContaining({ timeout: 5_000 }),
    );
  });

  it('keeps Claude Code blocked when auth status cannot prove a logged-in session', async () => {
    hoisted.readClaudeCliCredentialsMock.mockReturnValue(false);
    hoisted.spawnSyncMock.mockReturnValue({ stdout: '{"loggedIn":false}', stderr: '', status: 0 });
    const claudeAdapter: WorkerAdapter = {
      ...fakeAdapter,
      metadata: { ...fakeAdapter.metadata, id: 'claude_code', supported_sandbox_profiles: ['adapter-managed'] },
    };

    const report = await inspectWorkerAdapterLaneReadiness(claudeAdapter, 'review', {
      config: { command: 'node' },
    });

    expect(report.status).toBe('blocked');
    expect(report.summary).toContain('no authenticated session');
  });
});
