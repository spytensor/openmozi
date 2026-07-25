import { resolve } from 'node:path';
import type { ToolDefinition } from '../core/llm.js';
import type { ToolResult, ToolContext } from './types.js';
import { isPathInsideRoot } from './workspace-policy.js';

// ── Definitions ──

export const gitStatusTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'git_status',
    description: 'Get git repository status: branch, modified/added/deleted/untracked files. Always check before committing.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
};

export const gitDiffTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'git_diff',
    description: 'Show git diff of changes, optionally for a specific file. Always review diff before committing — do NOT commit unreviewed changes.',
    parameters: {
      type: 'object',
      properties: { file: { type: 'string', description: 'Specific file to diff (optional)' } },
      required: [],
      additionalProperties: false,
    },
  },
};

export const gitAddTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'git_add',
    description: 'Stage files for commit. Only stage files you have reviewed. Do NOT stage temporary or generated files.',
    parameters: {
      type: 'object',
      properties: { files: { type: 'array', items: { type: 'string' }, description: 'File paths to stage' } },
      required: ['files'],
      additionalProperties: false,
    },
  },
};

export const gitCommitTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'git_commit',
    description: 'Create a git commit with staged changes. Co-authored-by is auto-appended. Follow the project commit convention (feat/fix/refactor/docs/test/chore). Do NOT write vague messages like "update files".',
    parameters: {
      type: 'object',
      properties: { message: { type: 'string', description: 'Commit message' } },
      required: ['message'],
      additionalProperties: false,
    },
  },
};

export const gitPushTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'git_push',
    description: 'Push commits to remote repository. Force push is blocked for safety. Only push when the user explicitly requests it — never push automatically.',
    parameters: {
      type: 'object',
      properties: {
        remote: { type: 'string', description: 'Remote name (default: origin)' },
        branch: { type: 'string', description: 'Branch name (default: current branch)' },
      },
      required: [],
      additionalProperties: false,
    },
  },
};

export const gitLogTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'git_log',
    description: 'Show recent git commit history (default: 10 commits). Useful for understanding recent changes and debugging regressions.',
    parameters: {
      type: 'object',
      properties: { count: { type: 'number', description: 'Number of commits to show (default: 10)' } },
      required: [],
      additionalProperties: false,
    },
  },
};

export const gitRevertTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'git_revert',
    description: 'Revert the last N commits (max 5) safely by creating revert commits (preserves history). Always confirm with the user before reverting.',
    parameters: {
      type: 'object',
      properties: { count: { type: 'number', description: 'Number of commits to revert (default: 1, max: 5)' } },
      required: [],
      additionalProperties: false,
    },
  },
};

export const GIT_TOOLS: ToolDefinition[] = [
  gitStatusTool,
  gitDiffTool,
  gitAddTool,
  gitCommitTool,
  gitPushTool,
  gitLogTool,
  gitRevertTool,
];

// ── Executor ──

export async function executeGitTool(
  name: string,
  args: Record<string, unknown>,
  id: string,
  context?: ToolContext,
): Promise<ToolResult | null> {
  const cwd = context?.workingDirectory;
  if (cwd) {
    // A pinned working directory (delegated agent run) must be its own repo:
    // git resolves the nearest ancestor repo, which would let a sandboxed run
    // operate on an unrelated parent repository.
    const { gitToplevel } = await import('../tools/git.js');
    const toplevel = await gitToplevel(cwd);
    const pin = resolve(cwd);
    if (!toplevel || (resolve(toplevel) !== pin && !isPathInsideRoot(resolve(toplevel), pin))) {
      return {
        tool_call_id: id,
        content: `Error: ${cwd} is not a git repository. Run git init inside this directory before using git tools.`,
        is_error: true,
      };
    }
  }
  switch (name) {
    case 'git_status': {
      const { gitStatus } = await import('../tools/git.js');
      const status = await gitStatus(cwd);
      return { tool_call_id: id, content: JSON.stringify(status, null, 2), is_error: false };
    }

    case 'git_diff': {
      const { gitDiff } = await import('../tools/git.js');
      const diffFile = args.file as string | undefined;
      const diff = await gitDiff(diffFile, cwd);
      return { tool_call_id: id, content: diff || '(no changes)', is_error: false };
    }

    case 'git_add': {
      const { gitAdd } = await import('../tools/git.js');
      const files = args.files as string[];
      if (!Array.isArray(files) || files.length === 0) {
        return { tool_call_id: id, content: 'Error: "files" parameter is required and must be a non-empty array', is_error: true };
      }
      const addResult = await gitAdd(files, cwd);
      return { tool_call_id: id, content: addResult, is_error: false };
    }

    case 'git_commit': {
      const { gitCommit } = await import('../tools/git.js');
      const commitMsg = args.message as string;
      if (!commitMsg || typeof commitMsg !== 'string') {
        return { tool_call_id: id, content: 'Error: "message" parameter is required and must be a string', is_error: true };
      }
      const commitResult = await gitCommit(commitMsg, cwd);
      return { tool_call_id: id, content: JSON.stringify(commitResult, null, 2), is_error: false };
    }

    case 'git_push': {
      const { gitPush } = await import('../tools/git.js');
      const pushRemote = args.remote as string | undefined;
      const pushBranch = args.branch as string | undefined;
      const pushResult = await gitPush(pushRemote, pushBranch, cwd);
      return { tool_call_id: id, content: pushResult, is_error: false };
    }

    case 'git_log': {
      const { gitLog } = await import('../tools/git.js');
      const logCount = args.count as number | undefined;
      const entries = await gitLog(logCount, cwd);
      return { tool_call_id: id, content: JSON.stringify(entries, null, 2), is_error: false };
    }

    case 'git_revert': {
      const { gitRevert } = await import('../tools/git.js');
      const revertCount = args.count as number | undefined;
      const revertResult = await gitRevert(revertCount, cwd);
      return { tool_call_id: id, content: revertResult, is_error: false };
    }

    default:
      return null;
  }
}
