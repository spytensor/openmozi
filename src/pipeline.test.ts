import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: hoisted.execFileSyncMock,
}));

import { cmdPipelineCommit, cmdPipelineIssue } from './pipeline.js';

describe('pipeline command execution', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    hoisted.execFileSyncMock.mockReset();
    hoisted.execFileSyncMock.mockImplementation((command: string, args: string[]) => {
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'create') {
        return 'https://github.com/example/openmozi/issues/382\n';
      }
      if (command === 'git' && args.join(' ') === 'rev-parse --short HEAD') {
        return 'abc123\n';
      }
      return '';
    });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('passes backticks and command substitutions as literal execFile arguments', () => {
    const title = 'unsafe `touch /tmp/mozi-title` $(touch /tmp/mozi-title-2)';
    const body = 'body `touch /tmp/mozi-body` $(touch /tmp/mozi-body-2)';
    const message = 'commit `touch /tmp/mozi-commit` $(touch /tmp/mozi-commit-2)';

    expect(cmdPipelineIssue(title, body)).toBe(382);
    cmdPipelineCommit(382, message);

    const calls = hoisted.execFileSyncMock.mock.calls as Array<[string, string[], unknown]>;
    const issueCall = calls[0];
    expect(issueCall[0]).toBe('gh');
    expect(issueCall[1]).toEqual(['issue', 'create', '--title', title, '--body', body]);

    const commitCall = calls.find(([command, args]) => command === 'git' && args[0] === 'commit');
    expect(commitCall).toBeDefined();
    expect(commitCall![0]).toBe('git');
    expect(commitCall![1]).toEqual([
      'commit',
      '-m',
      `${message} (#382)\n\nCo-authored-by: Mozi <MoziAI-co@users.noreply.github.com>`,
    ]);
  });
});
