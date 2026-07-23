import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { exec } from '../capabilities/shell.js';
import { gitStatus, gitDiff, gitAdd, gitCommit, gitLog, gitPush, gitRevert, gitListBranches, gitSwitchBranch, isValidBranchName } from './git.js';

let tmpDir: string;

async function gitInit(dir: string): Promise<void> {
  await exec('git init', { cwd: dir, timeout: 10_000 });
  await exec('git config user.email "test@mozi.dev"', { cwd: dir, timeout: 10_000 });
  await exec('git config user.name "Test"', { cwd: dir, timeout: 10_000 });
}

describe('tools/git', () => {
  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mozi-git-test-'));
    await gitInit(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('gitStatus', () => {
    it('reports clean repo after init with an initial commit', async () => {
      // Create initial commit so we have a branch
      writeFileSync(join(tmpDir, 'README.md'), '# Test');
      await exec('git add .', { cwd: tmpDir, timeout: 10_000 });
      await exec('git commit -m "init"', { cwd: tmpDir, timeout: 10_000 });

      const status = await gitStatus(tmpDir);
      expect(status.clean).toBe(true);
      expect(status.modified).toEqual([]);
      expect(status.added).toEqual([]);
      expect(status.deleted).toEqual([]);
      expect(status.untracked).toEqual([]);
    });

    it('detects modified file', async () => {
      writeFileSync(join(tmpDir, 'file.txt'), 'initial');
      await exec('git add .', { cwd: tmpDir, timeout: 10_000 });
      await exec('git commit -m "init"', { cwd: tmpDir, timeout: 10_000 });

      // Modify the file
      writeFileSync(join(tmpDir, 'file.txt'), 'changed');

      const status = await gitStatus(tmpDir);
      expect(status.clean).toBe(false);
      expect(status.modified).toContain('file.txt');
    });

    it('detects untracked files', async () => {
      writeFileSync(join(tmpDir, 'new-file.txt'), 'hello');

      const status = await gitStatus(tmpDir);
      expect(status.clean).toBe(false);
      expect(status.untracked).toContain('new-file.txt');
    });
  });

  describe('gitDiff', () => {
    it('returns diff for modified file', async () => {
      writeFileSync(join(tmpDir, 'file.txt'), 'original\n');
      await exec('git add .', { cwd: tmpDir, timeout: 10_000 });
      await exec('git commit -m "init"', { cwd: tmpDir, timeout: 10_000 });

      writeFileSync(join(tmpDir, 'file.txt'), 'modified\n');

      const diff = await gitDiff(undefined, tmpDir);
      expect(diff).toContain('-original');
      expect(diff).toContain('+modified');
    });
  });

  describe('gitAdd + gitCommit', () => {
    it('stages and commits files, returns hash with Co-authored-by', async () => {
      writeFileSync(join(tmpDir, 'file.txt'), 'content');
      await gitAdd(['file.txt'], tmpDir);
      const result = await gitCommit('test commit', tmpDir);

      expect(result.hash).toBeTruthy();
      expect(result.hash).not.toBe('unknown');
      expect(result.message).toBe('test commit');

      // Verify Co-authored-by in the actual commit
      const logResult = await exec('git log -1 --format=%B', { cwd: tmpDir, timeout: 10_000 });
      expect(logResult.stdout).toContain('Co-authored-by: Mozi');
    });

    it('gitAdd throws on empty files array', async () => {
      await expect(gitAdd([], tmpDir)).rejects.toThrow('No files specified');
    });
  });

  describe('gitLog', () => {
    it('returns log entries', async () => {
      writeFileSync(join(tmpDir, 'a.txt'), '1');
      await exec('git add .', { cwd: tmpDir, timeout: 10_000 });
      await exec('git commit -m "first"', { cwd: tmpDir, timeout: 10_000 });

      writeFileSync(join(tmpDir, 'b.txt'), '2');
      await exec('git add .', { cwd: tmpDir, timeout: 10_000 });
      await exec('git commit -m "second"', { cwd: tmpDir, timeout: 10_000 });

      const entries = await gitLog(5, tmpDir);
      expect(entries.length).toBe(2);
      expect(entries[0].message).toBe('second');
      expect(entries[1].message).toBe('first');
      expect(entries[0].hash).toBeTruthy();
      expect(entries[0].author).toBe('Test');
    });
  });

  describe('gitPush safety', () => {
    it('rejects force push via remote argument', async () => {
      await expect(gitPush('--force', undefined, tmpDir)).rejects.toThrow('Force push is blocked');
    });

    it('rejects force push via branch argument', async () => {
      await expect(gitPush(undefined, '--force', tmpDir)).rejects.toThrow('Force push is blocked');
    });

    it('rejects -f flag', async () => {
      await expect(gitPush('-f', undefined, tmpDir)).rejects.toThrow('Force push is blocked');
    });
  });

  describe('gitRevert safety', () => {
    it('rejects count > 5', async () => {
      await expect(gitRevert(6, tmpDir)).rejects.toThrow('Revert count must be between 1 and 5');
    });

    it('rejects count < 1', async () => {
      await expect(gitRevert(0, tmpDir)).rejects.toThrow('Revert count must be between 1 and 5');
    });

    it('reverts a single commit', async () => {
      writeFileSync(join(tmpDir, 'file.txt'), 'v1');
      await exec('git add .', { cwd: tmpDir, timeout: 10_000 });
      await exec('git commit -m "v1"', { cwd: tmpDir, timeout: 10_000 });

      writeFileSync(join(tmpDir, 'file.txt'), 'v2');
      await exec('git add .', { cwd: tmpDir, timeout: 10_000 });
      await exec('git commit -m "v2"', { cwd: tmpDir, timeout: 10_000 });

      await gitRevert(1, tmpDir);

      // After revert, file should be back to v1
      const logEntries = await gitLog(5, tmpDir);
      expect(logEntries[0].message).toContain('Revert');
    });
  });

  describe('isValidBranchName', () => {
    it.each(['feature/x', 'fix-1', 'a.b', 'v1.2.3', 'user/deep/nest'])('accepts %s', (name) => {
      expect(isValidBranchName(name)).toBe(true);
    });

    it.each([
      '', '-f', '--force', 'a..b', 'a b', 'a~1', 'a:b', 'a?', 'a*', 'a[b',
      'a\\b', '@', 'a@{b', 'a.lock', 'sub/a.lock', '/a', 'a/', 'a.', '.a',
      'a//b', 'a\u0007b',
    ])('rejects %j', (name) => {
      expect(isValidBranchName(name)).toBe(false);
    });
  });

  describe('gitListBranches', () => {
    async function commit(message: string): Promise<void> {
      await exec(`git add . && git commit --allow-empty -m "${message}"`, { cwd: tmpDir, timeout: 10_000 });
    }

    it('lists branches sorted by committer date with current flagged', async () => {
      writeFileSync(join(tmpDir, 'a.txt'), 'a');
      await commit('init');
      await exec('git branch older', { cwd: tmpDir, timeout: 10_000 });
      // Make the current branch tip newer than "older".
      await exec('git commit --allow-empty -m "newer" --date="2030-01-01T00:00:00"', { cwd: tmpDir, timeout: 10_000, env: { GIT_COMMITTER_DATE: '2030-01-01T00:00:00' } });

      const result = await gitListBranches(tmpDir);
      expect(result.current.detached).toBe(false);
      expect(result.current.branch).toBeTruthy();
      expect(result.branches.map((b) => b.is_current)).toContain(true);
      expect(result.branches[0].is_current).toBe(true); // newest commit = current branch
      expect(result.branches.map((b) => b.name)).toContain('older');
    });

    it('counts dirty files (modified + untracked)', async () => {
      writeFileSync(join(tmpDir, 'a.txt'), 'a');
      await commit('init');
      writeFileSync(join(tmpDir, 'a.txt'), 'changed');
      writeFileSync(join(tmpDir, 'new.txt'), 'new');

      const result = await gitListBranches(tmpDir);
      expect(result.dirty_count).toBe(2);
    });

    it('reports detached HEAD with a short sha', async () => {
      writeFileSync(join(tmpDir, 'a.txt'), 'a');
      await commit('init');
      const head = await exec('git rev-parse HEAD', { cwd: tmpDir, timeout: 10_000 });
      await exec(`git checkout --detach ${head.stdout.trim()}`, { cwd: tmpDir, timeout: 10_000 });

      const result = await gitListBranches(tmpDir);
      expect(result.current.detached).toBe(true);
      expect(result.current.branch).toBeNull();
      expect(result.current.sha).toMatch(/^[0-9a-f]{4,}$/);
    });

    it('handles a zero-commit repo: unborn branch named, empty list', async () => {
      const result = await gitListBranches(tmpDir);
      expect(result.branches).toEqual([]);
      expect(result.current.branch).toBeTruthy();
      expect(result.current.sha).toBeNull();
      expect(result.current.detached).toBe(false);
    });

    it('parses subjects containing | and % intact', async () => {
      writeFileSync(join(tmpDir, 'a.txt'), 'a');
      await exec('git add .', { cwd: tmpDir, timeout: 10_000 });
      await exec('git commit -m "fix: a|b and 100% done"', { cwd: tmpDir, timeout: 10_000 });

      const result = await gitListBranches(tmpDir);
      expect(result.branches[0].subject).toBe('fix: a|b and 100% done');
    });

    it('throws on a non-repo directory', async () => {
      const bare = mkdtempSync(join(tmpdir(), 'mozi-notgit-'));
      try {
        await expect(gitListBranches(bare)).rejects.toThrow();
      } finally {
        rmSync(bare, { recursive: true, force: true });
      }
    });
  });

  describe('gitSwitchBranch', () => {
    async function initialCommit(): Promise<void> {
      writeFileSync(join(tmpDir, 'base.txt'), 'base');
      await exec('git add . && git commit -m "init"', { cwd: tmpDir, timeout: 10_000 });
    }

    it('switches cleanly and reports the previous branch', async () => {
      await initialCommit();
      await exec('git branch feature', { cwd: tmpDir, timeout: 10_000 });

      const result = await gitSwitchBranch(tmpDir, 'feature');
      expect(result.branch).toBe('feature');
      expect(['main', 'master']).toContain(result.previous);
      const head = await exec('git rev-parse --abbrev-ref HEAD', { cwd: tmpDir, timeout: 10_000 });
      expect(head.stdout.trim()).toBe('feature');
    });

    it('creates and switches with create: true', async () => {
      await initialCommit();
      const result = await gitSwitchBranch(tmpDir, 'feature/new', { create: true });
      expect(result.branch).toBe('feature/new');
      const head = await exec('git rev-parse --abbrev-ref HEAD', { cwd: tmpDir, timeout: 10_000 });
      expect(head.stdout.trim()).toBe('feature/new');
    });

    it('carries uncommitted changes across a non-conflicting switch', async () => {
      await initialCommit();
      await exec('git branch feature', { cwd: tmpDir, timeout: 10_000 });
      writeFileSync(join(tmpDir, 'wip.txt'), 'work in progress');

      await gitSwitchBranch(tmpDir, 'feature');
      const status = await exec('git status --porcelain', { cwd: tmpDir, timeout: 10_000 });
      expect(status.stdout).toContain('wip.txt'); // still uncommitted, carried over
    });

    it('aborts on conflict, leaving HEAD and the tree untouched', async () => {
      await initialCommit();
      // Branch B commits different content to base.txt.
      await exec('git switch -c b', { cwd: tmpDir, timeout: 10_000 });
      writeFileSync(join(tmpDir, 'base.txt'), 'b content');
      await exec('git add . && git commit -m "b"', { cwd: tmpDir, timeout: 10_000 });
      await exec('git switch -', { cwd: tmpDir, timeout: 10_000 });
      // Dirty conflicting edit on the original branch.
      writeFileSync(join(tmpDir, 'base.txt'), 'dirty conflicting');

      await expect(gitSwitchBranch(tmpDir, 'b')).rejects.toThrow(/overwritten|checkout/i);
      const head = await exec('git rev-parse --abbrev-ref HEAD', { cwd: tmpDir, timeout: 10_000 });
      expect(head.stdout.trim()).not.toBe('b');
      expect(readFileSync(join(tmpDir, 'base.txt'), 'utf-8')).toBe('dirty conflicting');
    });

    it('rejects an invalid branch name without spawning git', async () => {
      await expect(gitSwitchBranch(tmpDir, '--force')).rejects.toThrow(/Invalid branch name/);
    });

    it('surfaces the worktree already-checked-out error verbatim', async () => {
      await initialCommit();
      await exec('git branch wt', { cwd: tmpDir, timeout: 10_000 });
      const wtDir = join(tmpDir, '.wt');
      await exec(`git worktree add "${wtDir}" wt`, { cwd: tmpDir, timeout: 10_000 });

      await expect(gitSwitchBranch(tmpDir, 'wt')).rejects.toThrow(/already|used by worktree/i);
    });
  });

});
