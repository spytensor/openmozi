import pino from 'pino';
import { realpath } from 'node:fs/promises';
import { basename } from 'node:path';
import type { ToolDefinition } from '../core/llm.js';
import type { ToolResult, ToolContext } from './types.js';
import {
  classifyFileArtifactKind,
  mimeForFilePath,
  type FileArtifactData,
} from '../artifacts/file-artifacts.js';
import { buildFileArtifactPreviewFields } from '../artifacts/file-preview.js';
import { ensureArtifactCoordinator } from '../artifacts/coordinator.js';
import {
  resolveReadPath,
  resolveWritePath,
  resolveWriteRoots,
  getReadAllowedPaths,
  ensureToolWorkspaceDir,
  runTel,
  telErrorMessage,
  asRecord,
  isMissingFileError,
  createFileCheckpointHandle,
  finalizeFileCheckpoint,
  rollbackFileCheckpoint,
} from './tool-utils.js';
import {
  maybeEnableRepoInspection,
  recordGroundedDirectory,
  recordGroundedRead,
  resolveInspectionDirectoryPath,
  resolveInspectionReadPath,
} from './repo-grounding.js';

const logger = pino({ name: 'mozi:tools:fs' });

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

function fileArtifactDataForWrite(path: string, content: string): FileArtifactData | null {
  const filename = basename(path);
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const kind = classifyFileArtifactKind(ext);
  if (!kind || kind === 'code') return null;
  return {
    path,
    filename,
    ext,
    size: Buffer.byteLength(content),
    mime: mimeForFilePath(path),
    kind,
    downloadUrl: `/api/fs/file?${new URLSearchParams({ path }).toString()}`,
    ...buildFileArtifactPreviewFields(path, ext),
  };
}

// ── Definitions ──

export const readFileTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read the contents of a file (path relative to workspace). Always read a file before editing it. Do NOT assume you know a file\'s contents without reading it first.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path to read (relative to workspace)',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
};

export const writeFileTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'write_file',
    description: 'Write content to a file, creating parent directories if needed (path relative to workspace). Use for new files or complete replacements. For small changes to existing files, use edit_file instead. Always read a file before overwriting it.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path to write (relative to workspace)',
        },
        content: {
          type: 'string',
          description: 'Content to write to the file',
        },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
};

export const editFileTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'edit_file',
    description: 'Edit a file by replacing exact text. old_text must match exactly including whitespace. Preferred over write_file for modifications — always read the file first to get exact text. Do NOT use for creating new files (use write_file).',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path to edit (relative to workspace)',
        },
        old_text: {
          type: 'string',
          description: 'Exact text to find and replace',
        },
        new_text: {
          type: 'string',
          description: 'Text to replace old_text with',
        },
      },
      required: ['path', 'old_text', 'new_text'],
      additionalProperties: false,
    },
  },
};

export const appendFileTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'append_file',
    description: 'Append content to the end of a file. Use for logs, entries, or accumulating data. For inserting content in the middle of a file, use edit_file instead.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path to append to (relative to workspace)',
        },
        content: {
          type: 'string',
          description: 'Content to append to the file',
        },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
};

export const listDirectoryTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'list_directory',
    description: 'List files and directories at a path (relative to workspace, defaults to root). Use this instead of shell_exec with ls — it is purpose-built and safer.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path to list (relative to workspace, defaults to ".")',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
};

export const FS_TOOLS: ToolDefinition[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  appendFileTool,
  listDirectoryTool,
];

// ── Executor ──

export async function executeFsTool(
  name: string,
  args: Record<string, unknown>,
  id: string,
  context?: ToolContext,
): Promise<ToolResult | null> {
  const userId = context?.userId;
  switch (name) {
    case 'read_file': {
      const path = args.path as string;
      if (!path || typeof path !== 'string') {
        return { tool_call_id: id, content: 'Error: "path" parameter is required and must be a string', is_error: true };
      }
      await ensureToolWorkspaceDir(userId);
      maybeEnableRepoInspection(context?.repoInspection, path, context?.workspaceRootPath);
      const grounding = resolveInspectionReadPath(path, context?.repoInspection, userId, context?.workspaceRootPath);
      if (!grounding.resolvedPath) {
        return {
          tool_call_id: id,
          content: `Error: ${grounding.guidance ?? `Could not ground path: ${path}`}`,
          is_error: true,
        };
      }
      const resolved = grounding.resolvedPath;
      const allowedPaths = getReadAllowedPaths(userId, context?.workspaceRootPath);
      const telResult = await runTel('filesystem', 'read', {
        path: resolved,
        ...(allowedPaths ? { allowed_paths: allowedPaths } : {}),
      }, context);
      if (!telResult.success) {
        return { tool_call_id: id, content: `Error: ${telErrorMessage(telResult)}`, is_error: true };
      }
      const data = asRecord(telResult.data);
      const content = typeof data?.content === 'string' ? data.content : '';
      recordGroundedRead(context?.repoInspection, resolved);
      return { tool_call_id: id, content, is_error: false, file_path: resolved };
    }

    case 'write_file': {
      const path = args.path as string;
      const content = args.content as string;
      if (!path || typeof path !== 'string') {
        return { tool_call_id: id, content: 'Error: "path" parameter is required and must be a string', is_error: true };
      }
      if (content === undefined || content === null || typeof content !== 'string') {
        return { tool_call_id: id, content: 'Error: "content" parameter is required and must be a string', is_error: true };
      }
      await ensureToolWorkspaceDir(userId);
      const writeRoots = resolveWriteRoots(context);
      const resolved = resolveWritePath(path, userId, writeRoots, context?.workspaceRootPath);
      const allowedPaths = writeRoots;
      const checkpoint = createFileCheckpointHandle([resolved], name, id, context);
      const telResult = await runTel('filesystem', 'write', {
        path: resolved,
        content,
        ...(allowedPaths ? { allowed_paths: allowedPaths } : {}),
      }, context);
      if (!telResult.success) {
        const errorMessage = telErrorMessage(telResult);
        rollbackFileCheckpoint(checkpoint, name, id, errorMessage, context);
        return { tool_call_id: id, content: `Error: ${errorMessage}`, is_error: true };
      }
      finalizeFileCheckpoint(checkpoint, name, id);
      const canonicalResolved = await canonicalPath(resolved);
      const artifactCoordinator = context?.artifactCoordinator
        ?? (context?.onArtifact ? ensureArtifactCoordinator(context, context.turnId ?? id) : undefined);
      artifactCoordinator?.registerFileWrite(id, canonicalResolved);

      // Auto-emit artifact for renderable files (HTML, SVG).
      // Invariant: any pre-opened artifact MUST be terminalized
      // here regardless of content length, otherwise a short write leaves a
      // permanently-running card. Only open a brand-new card for non-trivial
      // writes — trivial writes without a pre-open do not create a card.
      const ext = resolved.split('.').pop()?.toLowerCase();
      const isRenderableExt = ext === 'html' || ext === 'htm' || ext === 'svg';
      const hasExistingArtifact = artifactCoordinator?.has(id) === true;
      let artifactVerified = false;
      if (isRenderableExt && artifactCoordinator && (hasExistingArtifact || content.length > 20)) {
        const contentType = ext === 'svg' ? 'svg' : 'html';
        const title = basename(resolved) || 'Preview';
        const data = { code: content, content_type: contentType };
        const artifactId = artifactCoordinator.openOrGet(id, {
          plugin_id: 'sandpack_v1',
          title,
          content_type: contentType,
          status: 'running',
          collapsed_by_default: false,
          fallback_text: `File: ${path}`,
          data,
        });
        const artifact = {
          id: artifactId,
          plugin_id: 'sandpack_v1',
          title,
          status: 'completed' as const,
          collapsed_by_default: false,
          fallback_text: `File: ${path}`,
          data,
          updated_at: new Date().toISOString(),
        };
        let emittedRenderableArtifact = false;
        try {
          artifactCoordinator.complete(id, {
            plugin_id: artifact.plugin_id,
            title: artifact.title,
            status: 'completed',
            fallback_text: artifact.fallback_text,
            data: artifact.data,
            updated_at: artifact.updated_at,
          });
          emittedRenderableArtifact = true;
          artifactVerified = true;
        } catch (err) {
          logger.error(
            { err: err instanceof Error ? err.message : String(err), artifactId: artifact.id, chatId: context?.chatId, sessionId: context?.sessionId },
            'write_file: failed to emit artifact event',
          );
        }
        if (emittedRenderableArtifact) {
          context?.turnRichArtifactPaths?.add(canonicalResolved);
        }
        // Persist artifact so it survives page refresh.
        const chatId = context?.chatId;
        if (!chatId) {
          logger.warn(
            { artifactId: artifact.id, sessionId: context?.sessionId },
            'write_file: artifact not persisted — missing chatId',
          );
        } else {
          try {
            const { saveMessage } = await import('../memory/conversations.js');
            saveMessage(chatId, 'tool', JSON.stringify({ _artifact: true, ...artifact }), undefined, undefined, context?.sessionId, context?.tenantId);
          } catch (err) {
            logger.error(
              { err: err instanceof Error ? err.message : String(err), artifactId: artifact.id, chatId, sessionId: context?.sessionId },
              'write_file: failed to persist artifact',
            );
          }
        }
      } else if (!isRenderableExt && artifactCoordinator) {
        const fileData = fileArtifactDataForWrite(canonicalResolved, content);
        if (fileData) {
          const artifactId = artifactCoordinator.openOrGet(id, {
            plugin_id: 'file_v1',
            title: fileData.filename,
            content_type: fileData.mime,
            status: 'running',
            collapsed_by_default: false,
            fallback_text: `File ready: ${fileData.filename}`,
            data: { ...fileData },
          });
          const updatedAt = new Date().toISOString();
          const artifact = {
            id: artifactId,
            plugin_id: 'file_v1',
            title: fileData.filename,
            status: 'completed' as const,
            collapsed_by_default: false,
            fallback_text: `File ready: ${fileData.filename}`,
            data: { ...fileData },
            updated_at: updatedAt,
          };
          artifactCoordinator.complete(id, {
            plugin_id: artifact.plugin_id,
            title: artifact.title,
            status: 'completed',
            fallback_text: artifact.fallback_text,
            data: artifact.data,
            updated_at: artifact.updated_at,
          });
          artifactVerified = true;
          const chatId = context?.chatId;
          if (!chatId) {
            logger.warn(
              { artifactId, sessionId: context?.sessionId },
              'write_file: file artifact not persisted — missing chatId',
            );
          } else {
            try {
              const { saveMessage } = await import('../memory/conversations.js');
              saveMessage(chatId, 'tool', JSON.stringify({ _artifact: true, ...artifact }), undefined, undefined, context?.sessionId, context?.tenantId);
            } catch (err) {
              logger.error(
                { err: err instanceof Error ? err.message : String(err), artifactId, chatId, sessionId: context?.sessionId },
                'write_file: failed to persist file artifact',
              );
            }
          }
        }
      }

      return {
        tool_call_id: id,
        content: `File written: ${path}`,
        is_error: false,
        file_path: resolved,
        artifact_verified: artifactVerified,
      };
    }

    case 'edit_file': {
      const path = args.path as string;
      const oldText = args.old_text as string;
      const newText = args.new_text as string;
      if (!path || typeof path !== 'string') {
        return { tool_call_id: id, content: 'Error: "path" parameter is required and must be a string', is_error: true };
      }
      if (oldText === undefined || oldText === null || typeof oldText !== 'string') {
        return { tool_call_id: id, content: 'Error: "old_text" parameter is required and must be a string', is_error: true };
      }
      if (newText === undefined || newText === null || typeof newText !== 'string') {
        return { tool_call_id: id, content: 'Error: "new_text" parameter is required and must be a string', is_error: true };
      }
      await ensureToolWorkspaceDir(userId);
      const writeRoots = resolveWriteRoots(context);
      const resolved = resolveWritePath(path, userId, writeRoots, context?.workspaceRootPath);
      const allowedPaths = writeRoots;
      const readResult = await runTel('filesystem', 'read', {
        path: resolved,
        ...(allowedPaths ? { allowed_paths: allowedPaths } : {}),
      }, context);
      if (!readResult.success) {
        return { tool_call_id: id, content: `Error: ${telErrorMessage(readResult)}`, is_error: true };
      }
      const readData = asRecord(readResult.data);
      const fileContent = typeof readData?.content === 'string' ? readData.content : '';
      const matchCount = fileContent.split(oldText).length - 1;
      if (matchCount === 0) {
        return { tool_call_id: id, content: 'Error: old_text not found in file', is_error: true };
      }
      if (matchCount > 1) {
        return { tool_call_id: id, content: `Error: old_text found ${matchCount} times, must appear exactly once`, is_error: true };
      }
      const updated = fileContent.replace(oldText, newText);
      const checkpoint = createFileCheckpointHandle([resolved], name, id, context);
      const writeResult = await runTel('filesystem', 'write', {
        path: resolved,
        content: updated,
        ...(allowedPaths ? { allowed_paths: allowedPaths } : {}),
      }, context);
      if (!writeResult.success) {
        const errorMessage = telErrorMessage(writeResult);
        rollbackFileCheckpoint(checkpoint, name, id, errorMessage, context);
        return { tool_call_id: id, content: `Error: ${errorMessage}`, is_error: true };
      }
      finalizeFileCheckpoint(checkpoint, name, id);
      return { tool_call_id: id, content: `File edited: ${path}`, is_error: false, file_path: resolved };
    }

    case 'append_file': {
      const path = args.path as string;
      const content = args.content as string;
      if (!path || typeof path !== 'string') {
        return { tool_call_id: id, content: 'Error: "path" parameter is required and must be a string', is_error: true };
      }
      if (content === undefined || content === null || typeof content !== 'string') {
        return { tool_call_id: id, content: 'Error: "content" parameter is required and must be a string', is_error: true };
      }
      await ensureToolWorkspaceDir(userId);
      const writeRoots = resolveWriteRoots(context);
      const resolved = resolveWritePath(path, userId, writeRoots, context?.workspaceRootPath);
      const allowedPaths = writeRoots;
      const checkpoint = createFileCheckpointHandle([resolved], name, id, context);
      // Use atomic append (appendFileSync) instead of read-modify-write to avoid
      // race conditions when multiple sessions append to the same file concurrently.
      const appendResult = await runTel('filesystem', 'append', {
        path: resolved,
        content,
        ...(allowedPaths ? { allowed_paths: allowedPaths } : {}),
      }, context);
      if (!appendResult.success) {
        const errorMessage = telErrorMessage(appendResult);
        rollbackFileCheckpoint(checkpoint, name, id, errorMessage, context);
        return { tool_call_id: id, content: `Error: ${errorMessage}`, is_error: true };
      }
      finalizeFileCheckpoint(checkpoint, name, id);
      return { tool_call_id: id, content: `Content appended to: ${path}`, is_error: false, file_path: resolved };
    }

    case 'list_directory': {
      const path = (args.path as string) || '.';
      await ensureToolWorkspaceDir(userId);
      maybeEnableRepoInspection(context?.repoInspection, path, context?.workspaceRootPath);
      const grounding = resolveInspectionDirectoryPath(path, context?.repoInspection, userId, context?.workspaceRootPath);
      if (!grounding.resolvedPath) {
        return {
          tool_call_id: id,
          content: `Error: ${grounding.guidance ?? `Could not ground directory path: ${path}`}`,
          is_error: true,
        };
      }
      const resolved = grounding.resolvedPath;
      const allowedPaths = getReadAllowedPaths(userId, context?.workspaceRootPath);
      const telResult = await runTel('filesystem', 'list', {
        path: resolved,
        ...(allowedPaths ? { allowed_paths: allowedPaths } : {}),
      }, context);
      if (!telResult.success) {
        return { tool_call_id: id, content: `Error: ${telErrorMessage(telResult)}`, is_error: true };
      }
      const data = asRecord(telResult.data);
      const entries = Array.isArray(data?.entries) ? data.entries : [];
      const formatted = entries
        .map((e: unknown) => {
          const row = asRecord(e);
          const isDirectory = row?.is_directory === true;
          const entryName = typeof row?.name === 'string' ? row.name : '(unknown)';
          const size = typeof row?.size === 'number' ? row.size : 0;
          return `${isDirectory ? 'd' : 'f'} ${entryName} (${size}B)`;
        })
        .join('\n');
      recordGroundedDirectory(context?.repoInspection, resolved);
      return { tool_call_id: id, content: formatted || '(empty directory)', is_error: false };
    }

    default:
      return null;
  }
}
