import { exec, execFile } from '../capabilities/shell.js';
import { getRuntimeProjectRoot } from '../runtime/project-root.js';
import pino from 'pino';

const logger = pino({ name: 'mozi:git' });

const CO_AUTHOR = 'Co-authored-by: Mozi <MoziAI-co@users.noreply.github.com>';
const PROTECTED_BRANCHES = ['main', 'master'];

export interface GitStatusResult {
  branch: string;
  modified: string[];
  added: string[];
  deleted: string[];
  untracked: string[];
  clean: boolean;
}

export interface GitCommitResult {
  hash: string;
  message: string;
  files_changed: number;
}

export interface GitLogEntry {
  hash: string;
  message: string;
  author: string;
  date: string;
}

const GIT_TIMEOUT = 30_000;

function gitOpts(cwd?: string) {
  return { timeout: GIT_TIMEOUT, cwd: cwd ?? getRuntimeProjectRoot() };
}

/** Get git repository status: branch, modified/added/deleted/untracked files */
export async function gitStatus(cwd?: string): Promise<GitStatusResult> {
  const result = await exec('git status --porcelain -b', gitOpts(cwd));
  if (result.exit_code !== 0) {
    throw new Error(`git status failed: ${result.stderr}`);
  }

  const lines = result.stdout.split('\n').filter(Boolean);
  let branch = '';
  const modified: string[] = [];
  const added: string[] = [];
  const deleted: string[] = [];
  const untracked: string[] = [];

  for (const line of lines) {
    if (line.startsWith('## ')) {
      // ## main...origin/main or ## main or ## No commits yet on main
      const branchPart = line.slice(3);
      branch = branchPart.split('...')[0].replace('No commits yet on ', '');
      continue;
    }

    const xy = line.slice(0, 2);
    const file = line.slice(3);

    if (xy === '??') {
      untracked.push(file);
    } else {
      if (xy[0] === 'A' || xy[1] === 'A') added.push(file);
      if (xy[0] === 'M' || xy[1] === 'M') modified.push(file);
      if (xy[0] === 'D' || xy[1] === 'D') deleted.push(file);
    }
  }

  return {
    branch,
    modified,
    added,
    deleted,
    untracked,
    clean: modified.length === 0 && added.length === 0 && deleted.length === 0 && untracked.length === 0,
  };
}

/** Show git diff of changes. Optionally for a specific file */
export async function gitDiff(file?: string, cwd?: string): Promise<string> {
  const escapedFile = file ? `'${file.replace(/'/g, "'\\''")}'` : undefined;
  const cmd = escapedFile ? `git diff -- ${escapedFile}` : 'git diff';
  const result = await exec(cmd, gitOpts(cwd));
  if (result.exit_code !== 0) {
    throw new Error(`git diff failed: ${result.stderr}`);
  }
  return result.stdout;
}

/** Stage files for commit */
export async function gitAdd(files: string[], cwd?: string): Promise<string> {
  if (!files || files.length === 0) {
    throw new Error('No files specified for git add');
  }
  const escaped = files.map(f => `'${f.replace(/'/g, "'\\''")}'`).join(' ');
  const result = await exec(`git add ${escaped}`, gitOpts(cwd));
  if (result.exit_code !== 0) {
    throw new Error(`git add failed: ${result.stderr}`);
  }
  return result.stdout || 'Files staged successfully';
}

/** Create a git commit. Co-authored-by is automatically appended */
export async function gitCommit(message: string, cwd?: string): Promise<GitCommitResult> {
  if (!message || typeof message !== 'string') {
    throw new Error('Commit message is required');
  }

  const fullMessage = `${message}\n\n${CO_AUTHOR}`;
  // Use a heredoc-style approach to avoid shell escaping issues
  const escapedMessage = fullMessage.replace(/'/g, "'\\''");
  const result = await exec(`git commit -m '${escapedMessage}'`, gitOpts(cwd));
  if (result.exit_code !== 0) {
    throw new Error(`git commit failed: ${result.stderr}`);
  }

  // Get the commit hash reliably via git rev-parse
  const hashResult = await exec('git rev-parse --short HEAD', gitOpts(cwd));
  const hash = hashResult.exit_code === 0 ? hashResult.stdout.trim() : 'unknown';

  // Count files changed from output like "1 file changed, ..."
  const combined = result.stdout + result.stderr;
  const filesMatch = combined.match(/(\d+) files? changed/);
  const files_changed = filesMatch ? parseInt(filesMatch[1], 10) : 0;

  return { hash, message, files_changed };
}

/** Push commits to remote. Force push is blocked for safety */
export async function gitPush(remote?: string, branch?: string, cwd?: string): Promise<string> {
  const r = remote ?? 'origin';
  const b = branch ?? '';

  // Safety: reject force push
  if (r.includes('--force') || r.includes('-f') || b.includes('--force') || b.includes('-f')) {
    throw new Error('Force push is blocked for safety. Use the git CLI directly if needed.');
  }

  // Determine branch if not specified
  let targetBranch = b;
  if (!targetBranch) {
    const headResult = await exec('git rev-parse --abbrev-ref HEAD', gitOpts(cwd));
    if (headResult.exit_code !== 0) {
      throw new Error(`Failed to determine current branch: ${headResult.stderr}`);
    }
    targetBranch = headResult.stdout.trim();
  }

  // Warn about protected branches
  if (PROTECTED_BRANCHES.includes(targetBranch)) {
    throw new Error(`Pushing to protected branch "${targetBranch}" is not allowed via this tool.`);
  }

  const escapedRemote = `'${r.replace(/'/g, "'\\''")}'`;
  const escapedBranch = `'${targetBranch.replace(/'/g, "'\\''")}'`;
  const result = await exec(`git push ${escapedRemote} ${escapedBranch}`, gitOpts(cwd));
  if (result.exit_code !== 0) {
    throw new Error(`git push failed: ${result.stderr}`);
  }
  return result.stdout || result.stderr || 'Push successful';
}

/** Show recent git commit history */
export async function gitLog(count?: number, cwd?: string): Promise<GitLogEntry[]> {
  const n = count ?? 10;
  if (!Number.isInteger(n)) {
    throw new Error('Git log count must be an integer');
  }
  const result = await exec(`git log --format="%H|%s|%an|%ai" -n ${n}`, gitOpts(cwd));
  if (result.exit_code !== 0) {
    throw new Error(`git log failed: ${result.stderr}`);
  }

  return result.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, message, author, date] = line.split('|');
      return { hash, message, author, date };
    });
}

/** Revert the last N commits (max 5) safely */
export async function gitRevert(count?: number, cwd?: string): Promise<string> {
  const n = count ?? 1;
  if (n < 1 || n > 5) {
    throw new Error('Revert count must be between 1 and 5');
  }

  const result = await exec(`git revert --no-edit HEAD~${n}..HEAD`, gitOpts(cwd));
  if (result.exit_code !== 0) {
    throw new Error(`git revert failed: ${result.stderr}`);
  }
  return result.stdout || 'Revert successful';
}

// ---------------------------------------------------------------------------
// Branch listing / switching (composer branch picker)
// ---------------------------------------------------------------------------

export interface GitBranchInfo {
  name: string;
  /** ISO-strict committer date of the branch tip, null if unparseable. */
  last_commit_at: string | null;
  subject: string;
  is_current: boolean;
}

export interface GitBranchListResult {
  current: { branch: string | null; detached: boolean; sha: string | null };
  /** `git status --porcelain` line count (staged + unstaged + untracked). */
  dirty_count: number;
  /** Local branches, sorted by committer date (newest first, by git itself). */
  branches: GitBranchInfo[];
}

/**
 * Validate a branch name against the rules of `git check-ref-format --branch`.
 * Doubles as argv-injection defense: rejects a leading '-' so a name can never
 * be mistaken for an option even though we always exec with argv semantics.
 */
export function isValidBranchName(name: string): boolean {
  if (!name || name.length > 244) return false;
  if (name === '@') return false;
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/')) return false;
  if (name.startsWith('.') || name.endsWith('.')) return false;
  if (name.includes('..') || name.includes('//') || name.includes('@{')) return false;
  // Control chars, space, and git's forbidden ref characters.
  if (/[\x00-\x20~^:?*[\\\x7f]/.test(name)) return false;
  // No component may start with '.' or end with '.lock'.
  return name.split('/').every((part) => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock'));
}

/** List local branches plus current-HEAD state and working-tree dirtiness. */
export async function gitListBranches(cwd: string): Promise<GitBranchListResult> {
  const forEachRef = await execFile('git', [
    'for-each-ref',
    'refs/heads',
    '--sort=-committerdate',
    // NUL-separated fields: subjects may contain '|' or '%'.
    '--format=%(refname:short)%00%(committerdate:iso-strict)%00%(HEAD)%00%(subject)',
  ], gitOpts(cwd));
  if (forEachRef.exit_code !== 0) {
    throw new Error(forEachRef.stderr.trim() || 'git for-each-ref failed');
  }

  // Exit 1 with empty output = detached HEAD; still succeeds on an unborn branch.
  const symbolicRef = await execFile('git', ['symbolic-ref', '--short', '-q', 'HEAD'], gitOpts(cwd));
  const currentBranch = symbolicRef.exit_code === 0 ? symbolicRef.stdout.trim() : null;

  const revParse = await execFile('git', ['rev-parse', '--short', 'HEAD'], gitOpts(cwd));
  const sha = revParse.exit_code === 0 ? revParse.stdout.trim() : null;

  const status = await execFile('git', ['status', '--porcelain'], gitOpts(cwd));
  const dirtyCount = status.exit_code === 0
    ? status.stdout.split('\n').filter((line) => line.trim().length > 0).length
    : 0;

  const branches: GitBranchInfo[] = forEachRef.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, date, head, subject] = line.split('\0');
      return {
        name,
        last_commit_at: date || null,
        subject: subject ?? '',
        is_current: head === '*',
      };
    });

  return {
    current: { branch: currentBranch, detached: currentBranch === null && sha !== null, sha },
    dirty_count: dirtyCount,
    branches,
  };
}

/**
 * Switch (or create-and-switch) a branch via plain `git switch` — uncommitted
 * changes are carried over per git defaults; on conflict git aborts and the
 * tree is untouched. Never forces, never stashes. Throws git's stderr verbatim
 * so callers can surface the real reason.
 */
export async function gitSwitchBranch(
  cwd: string,
  branch: string,
  opts?: { create?: boolean },
): Promise<{ branch: string; previous: string | null }> {
  if (!isValidBranchName(branch)) {
    throw new Error(`Invalid branch name: ${branch}`);
  }
  const before = await execFile('git', ['symbolic-ref', '--short', '-q', 'HEAD'], gitOpts(cwd));
  const previous = before.exit_code === 0 ? before.stdout.trim() : null;

  const args = opts?.create ? ['switch', '-c', branch] : ['switch', branch];
  const result = await execFile('git', args, gitOpts(cwd));
  if (result.exit_code !== 0) {
    throw new Error(result.stderr.trim() || `git switch failed (exit ${result.exit_code})`);
  }
  return { branch, previous };
}
