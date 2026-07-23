import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  recover: vi.fn(),
}));

vi.mock('./tool-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tool-utils.js')>();
  return {
    ...actual,
    ensureToolWorkspaceDir: vi.fn(async () => '/tmp'),
    requireShellApprovalIfNeeded: vi.fn(() => null),
    createFileCheckpointHandle: vi.fn(() => null),
    finalizeFileCheckpoint: vi.fn(),
    rollbackFileCheckpoint: vi.fn(),
    runTel: vi.fn(async () => ({
      success: true,
      data: {
        blocked: false,
        timed_out: false,
        exit_code: 1,
        stdout: '',
        stderr: "Traceback: ModuleNotFoundError: No module named 'matplotlib'",
      },
    })),
  };
});

vi.mock('../skills/dependency-ledger.js', () => ({
  recoverDeclaredSkillDependency: hoisted.recover,
}));

import { executeShellTool } from './shell-tools.js';

describe('shell dependency recovery wiring', () => {
  beforeEach(() => {
    hoisted.recover.mockReset();
    hoisted.recover.mockResolvedValue({
      status: 'provisioned',
      dependency: { kind: 'python', name: 'matplotlib' },
      skill: { name: 'data-analysis', description: 'Analyze data' },
      message: 'Runtime provisioned and verified matplotlib from skill data-analysis. Retry the failed command.',
    });
  });

  it('keeps the failed command truthful while attaching managed recovery and skill activation metadata', async () => {
    const result = await executeShellTool(
      'shell_exec',
      { command: 'python3 report.py' },
      'call-report',
      {
        userId: 'user',
        tenantId: 'tenant',
        sessionId: 'session',
        chatId: 'chat',
        agentId: 'agent',
        permissionLevel: 'L2_SHELL_EXEC',
      },
    );

    expect(result).toMatchObject({
      is_error: true,
      skillName: 'data-analysis',
      skillLoadOutcome: 'success',
    });
    expect(result?.content).toContain('ModuleNotFoundError');
    expect(result?.content).toContain('[RUNTIME DEPENDENCY RECOVERY]');
    expect(result?.content).toContain('Retry the failed command');
    expect(hoisted.recover).toHaveBeenCalledWith(expect.stringContaining('ModuleNotFoundError'), expect.objectContaining({ sessionId: 'session' }));
  });
});
