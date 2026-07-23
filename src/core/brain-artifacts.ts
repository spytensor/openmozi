import type { ArtifactEvent } from '../artifacts/types.js';
import { normalizeArtifactContentType } from '../artifacts/content-contract.js';
import type { ToolContext } from '../tools/types.js';
import { emit as emitProgress } from '../progress/event-bus.js';

interface LiveArtifactTrackerParams {
  chatId: string;
  tenantId: string;
  turnId: string;
  toolContext: ToolContext;
}

// NOTE(2026-07-18, operator root-cause decision): userExplicitlyRequestsArtifact /
// resolveArtifactContract / the "[SYSTEM ARTIFACT CONTRACT]" repair directive are
// DELETED. A keyword regex deciding user intent ("mentioned html ⇒ wants an HTML
// artifact") had the runtime second-guessing the Brain and misfired on a file
// path, forcing an unrequested artifact and visible self-narration. Artifact
// policy belongs to SOUL; deliverable truthfulness to the completion gate.

/**
 * True when the payload carries actual renderable artifact content (non-empty
 * `code` or `markdown`). A bare pre-opened live placeholder emits neither field
 * (only `content_type` / `live_preview`), so it correctly returns false.
 */
function artifactPayloadHasRenderableContent(data: Record<string, unknown> | undefined): boolean {
  if (!data) return false;
  const code = data.code;
  if (typeof code === 'string' && code.trim().length > 0) return true;
  const markdown = data.markdown;
  if (typeof markdown === 'string' && markdown.trim().length > 0) return true;
  return false;
}

/**
 * Whether an artifact event actually delivers renderable content, used to
 * satisfy the artifact contract. A pre-opened live placeholder (no meaningful
 * content) must NOT count; any open/patch that carries real content — including
 * a mid-stream running patch — does. A terminal `completed` status also counts.
 */
export function isRenderableArtifactEvent(event: ArtifactEvent): boolean {
  if (event.type === 'open') {
    return event.artifact.status === 'completed'
      || artifactPayloadHasRenderableContent(event.artifact.data);
  }
  if (event.type === 'patch') {
    return event.patch.status === 'completed'
      || artifactPayloadHasRenderableContent(event.patch.data);
  }
  return false;
}

export function parseToolArguments(argsJson: string): Record<string, unknown> | null {
  try {
    return JSON.parse(argsJson) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function artifactContentTypeFromPath(path: string): 'html' | 'svg' | null {
  const ext = path.split('.').pop()?.toLowerCase();
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'svg') return 'svg';
  return null;
}

interface PreopenRenderableArtifact {
  title: string;
  contentType: string;
  code: string;
  fallbackText: string;
  path?: string;
}

export function buildPreopenRenderableArtifact(
  toolName: string,
  args: Record<string, unknown> | null,
): PreopenRenderableArtifact | null {
  if (toolName === 'create_artifact') {
    const contentType = typeof args?.content_type === 'string' ? args.content_type : 'html';
    if (!['html', 'svg', 'react', 'javascript', 'markdown', 'document'].includes(contentType)) return null;
    const title = (typeof args?.title === 'string' && args.title.trim()) ? args.title.trim() : 'Generating artifact';
    const code = typeof args?.code === 'string' ? args.code : '';
    return {
      title,
      contentType,
      code,
      fallbackText: code.trim() ? 'Rendering preview...' : 'Generating preview...',
    };
  }

  if (toolName === 'write_file') {
    const path = typeof args?.path === 'string' ? args.path : '';
    const contentType = artifactContentTypeFromPath(path);
    if (!contentType) return null;
    const title = path.split('/').filter(Boolean).pop() || 'Generating preview';
    const code = typeof args?.content === 'string' ? args.content : '';
    return {
      title,
      contentType,
      code,
      fallbackText: code.trim() ? 'Rendering preview...' : 'Generating preview...',
      path,
    };
  }

  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeJsonStringPrefix(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '"') break;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    if (i + 1 >= value.length) break;
    const next = value[++i];
    switch (next) {
      case '"':
      case '\\':
      case '/':
        out += next;
        break;
      case 'b':
        out += '\b';
        break;
      case 'f':
        out += '\f';
        break;
      case 'n':
        out += '\n';
        break;
      case 'r':
        out += '\r';
        break;
      case 't':
        out += '\t';
        break;
      case 'u': {
        const hex = value.slice(i + 1, i + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return out;
        out += String.fromCharCode(parseInt(hex, 16));
        i += 4;
        break;
      }
      default:
        out += next;
        break;
    }
  }
  return out;
}

function extractStreamingJsonStringField(input: string, field: string): string | null {
  try {
    const parsed = JSON.parse(input) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const value = (parsed as Record<string, unknown>)[field];
      return typeof value === 'string' ? value : null;
    }
    return null;
  } catch {
    // Partial tool-input JSON is expected while the model is still streaming.
  }

  const match = new RegExp(`"${escapeRegExp(field)}"\\s*:\\s*"`).exec(input);
  if (!match) return null;
  return decodeJsonStringPrefix(input.slice(match.index + match[0].length));
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() || path;
}

function normalizeLiveArtifactContentType(value: string | null | undefined): string {
  const normalized = (value ?? '').toLowerCase();
  if (normalized === 'document') return 'markdown';
  if (['html', 'svg', 'react', 'javascript', 'markdown'].includes(normalized)) return normalized;
  return 'markdown';
}

export function artifactEventContentType(event: ArtifactEvent): string | null {
  if (event.type === 'open') {
    const contentType = event.artifact.data.content_type;
    return typeof contentType === 'string' ? contentType : null;
  }
  if (event.type === 'patch') {
    const contentType = event.patch.data?.content_type;
    return typeof contentType === 'string' ? contentType : null;
  }
  return null;
}

function isDocumentContentType(contentType: string): boolean {
  return contentType === 'markdown' || contentType === 'document';
}

function liveArtifactFallback(contentType: string, hasContent: boolean): string {
  if (!hasContent) return 'Preparing live preview...';
  if (isDocumentContentType(contentType)) return 'Writing document...';
  return 'Rendering preview...';
}

export function emitTurnExecutionDetail(params: LiveArtifactTrackerParams, detail: string): void {
  emitProgress({
    type: 'turn_state',
    chatId: params.chatId,
    tenantId: params.tenantId,
    sessionId: params.toolContext.sessionId,
    turnId: params.turnId,
    turnState: 'EXECUTING',
    detail,
  });
}

interface LiveArtifactDraft {
  toolCallId: string;
  toolName: string;
  input: string;
  lastContent: string;
  lastTitle: string;
  lastContentType: string;
  lastEmitAt: number;
  opened: boolean;
  terminalEmitted: boolean;
}

export function createLiveArtifactInputTracker(params: LiveArtifactTrackerParams) {
  const drafts = new Map<string, LiveArtifactDraft>();
  const minEmitIntervalMs = 160;

  const resolveDraftFields = (draft: LiveArtifactDraft): {
    title: string;
    contentType: string;
    content: string;
    path?: string;
  } => {
    if (draft.toolName === 'write_file') {
      const path = extractStreamingJsonStringField(draft.input, 'path') ?? '';
      const content = extractStreamingJsonStringField(draft.input, 'content') ?? '';
      const contentType = artifactContentTypeFromPath(path) ?? 'html';
      return {
        title: path ? basename(path) : draft.lastTitle,
        contentType,
        content,
        path,
      };
    }

    const title = extractStreamingJsonStringField(draft.input, 'title') ?? draft.lastTitle;
    const content = extractStreamingJsonStringField(draft.input, 'code') ?? '';
    const declaredContentType = extractStreamingJsonStringField(draft.input, 'content_type') ?? draft.lastContentType;
    const contentType = normalizeLiveArtifactContentType(normalizeArtifactContentType(declaredContentType, content));
    return { title, contentType, content };
  };

  const emitPatch = (draft: LiveArtifactDraft, force = false): void => {
    const coordinator = params.toolContext.artifactCoordinator;
    if (!coordinator) return;
    if (!draft.opened || draft.terminalEmitted) return;
    const now = Date.now();
    if (!force && now - draft.lastEmitAt < minEmitIntervalMs) return;

    const fields = resolveDraftFields(draft);
    const hasContent = fields.content.trim().length > 0;
    const changed =
      fields.content !== draft.lastContent ||
      fields.title !== draft.lastTitle ||
      fields.contentType !== draft.lastContentType;
    if (!changed && !force) return;

    draft.lastEmitAt = now;
    draft.lastContent = fields.content;
    draft.lastTitle = fields.title;
    draft.lastContentType = fields.contentType;

    const data = isDocumentContentType(fields.contentType)
      ? {
          markdown: fields.content,
          content_type: 'markdown',
          live_preview: true,
          phase: 'writing',
          tool_name: draft.toolName,
          meta: { turn_id: params.turnId },
        }
      : {
          code: fields.content,
          content_type: fields.contentType,
          live_preview: true,
          phase: 'rendering',
          tool_name: draft.toolName,
          meta: { turn_id: params.turnId },
        };

    coordinator.patch(draft.toolCallId, {
      title: fields.title,
      status: 'running',
      fallback_text: liveArtifactFallback(fields.contentType, hasContent),
      data,
      updated_at: new Date().toISOString(),
    });
  };

  const openDraft = (draft: LiveArtifactDraft): boolean => {
    const coordinator = params.toolContext.artifactCoordinator;
    if (!coordinator) return false;
    if (draft.opened || draft.terminalEmitted) return draft.opened;

    let initialTitle = draft.lastTitle;
    let initialContentType = draft.lastContentType;
    let path: string | undefined;
    if (draft.toolName === 'write_file') {
      path = extractStreamingJsonStringField(draft.input, 'path') ?? '';
      const contentType = artifactContentTypeFromPath(path);
      if (!path || !contentType) return false;
      initialTitle = basename(path);
      initialContentType = contentType;
    }

    draft.opened = true;
    draft.lastTitle = initialTitle;
    draft.lastContentType = initialContentType;
    emitTurnExecutionDetail(params, draft.toolName === 'create_artifact' ? 'Writing artifact' : 'Preparing preview');

    coordinator.openOrGet(draft.toolCallId, {
      plugin_id: 'live_work_v1',
      title: initialTitle,
      content_type: initialContentType,
      status: 'running',
      collapsed_by_default: false,
      fallback_text: 'Preparing live preview...',
      data: {
        content_type: initialContentType,
        live_preview: true,
        phase: 'preparing',
        tool_name: draft.toolName,
        meta: { turn_id: params.turnId },
      },
    });
    return true;
  };

  return {
    start(toolCallId: string, toolName: string): void {
      if (!params.toolContext.artifactCoordinator) return;
      if (toolName !== 'create_artifact' && toolName !== 'write_file') return;
      if (drafts.has(toolCallId)) return;

      const initialContentType = toolName === 'create_artifact' ? 'markdown' : 'html';
      const initialTitle = toolName === 'create_artifact' ? 'Generating artifact' : 'Generating preview';
      const draft: LiveArtifactDraft = {
        toolCallId,
        toolName,
        input: '',
        lastContent: '',
        lastTitle: initialTitle,
        lastContentType: initialContentType,
        lastEmitAt: 0,
        opened: false,
        terminalEmitted: false,
      };
      drafts.set(toolCallId, draft);
      if (toolName === 'create_artifact') {
        openDraft(draft);
      }
    },

    append(toolCallId: string, delta: string): void {
      const draft = drafts.get(toolCallId);
      if (!draft) return;
      draft.input += delta;
      if (!draft.opened) openDraft(draft);
      emitPatch(draft);
    },

    end(toolCallId: string): void {
      const draft = drafts.get(toolCallId);
      if (!draft) return;
      if (!draft.opened) openDraft(draft);
      emitPatch(draft, true);
    },

    flushAll(): void {
      for (const draft of drafts.values()) {
        if (!draft.opened) openDraft(draft);
        emitPatch(draft, true);
      }
    },

    failAll(reason = 'Artifact generation interrupted'): void {
      const coordinator = params.toolContext.artifactCoordinator;
      if (!coordinator) return;
      for (const draft of drafts.values()) {
        if (!draft.opened || draft.terminalEmitted) continue;
        draft.terminalEmitted = true;
        coordinator.complete(draft.toolCallId, {
          title: draft.lastTitle,
          status: 'failed',
          fallback_text: reason,
          data: {
            content_type: draft.lastContentType,
            live_preview: true,
            phase: 'failed',
            tool_name: draft.toolName,
            meta: { turn_id: params.turnId },
          },
          updated_at: new Date().toISOString(),
        });
      }
    },
  };
}
