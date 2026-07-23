import type { ToolContext } from './types.js';

export type ExecutionSurface =
  | 'interactive'
  | 'dag_step'
  | 'subagent_fallback'
  | 'background_job'
  | 'recovery'
  | 'proactive';

export interface SurfaceContextDeclaration {
  provides: Array<keyof ToolContext>;
  unsupported: Array<keyof ToolContext>;
}

export const EXECUTION_CONTEXT_FIELDS = [
  'chatId',
  'channelType',
  'tenantId',
  'sessionId',
  'userId',
  'agentId',
  'permissionLevel',
  'scopeGrants',
  'abortSignal',
  'taskId',
  'onArtifact',
  'artifactHints',
  'turnRichArtifactPaths',
  'artifactCoordinator',
  'permissionElevationRequests',
  'writeConfirmedByElevation',
  'executionModel',
  'systemPrompt',
  'originalRequest',
  'planDeliveryMode',
  'turnOrigin',
] as const satisfies ReadonlyArray<keyof ToolContext>;

type ExecutionContextField = (typeof EXECUTION_CONTEXT_FIELDS)[number];

function declaration(
  provides: ExecutionContextField[],
  unsupported: ExecutionContextField[],
): SurfaceContextDeclaration {
  return { provides, unsupported };
}

export const SURFACE_CONTEXT_DECLARATIONS: Record<ExecutionSurface, SurfaceContextDeclaration> = {
  interactive: declaration(
    [
      'chatId',
      'channelType',
      'tenantId',
      'sessionId',
      'userId',
      'agentId',
      'permissionLevel',
      'scopeGrants',
      'abortSignal',
      'onArtifact',
      'artifactHints',
      'turnRichArtifactPaths',
      'artifactCoordinator',
      'permissionElevationRequests',
      'writeConfirmedByElevation',
      'executionModel',
      'systemPrompt',
      'originalRequest',
      'planDeliveryMode',
      'turnOrigin',
    ],
    ['taskId'],
  ),
  dag_step: declaration(
    // onArtifact IS provided: detached plan steps create real deliverables
    // (create_artifact), and without the callback those artifacts never reach
    // the session timeline — the user got a container file path in text.
    //
    // userId IS provided: every write path resolves the workspace through it —
    // resolveWritePath, ensureToolWorkspaceDir, persistArtifactContent — and
    // getWorkspaceDir falls back to the shared legacy workspace when it is
    // missing. Deleting it here sent every file a plan step produced into a root
    // the file API does not serve for a real user, so the deliverable existed on
    // disk and its card 404'd. sessionId was already provided; a surface that
    // knows the session but not whose it is cannot resolve that user's storage.
    // turnOrigin IS provided: the executor's unattended approval discipline
    // (#824) reads it, and scheduled plans execute every step through this
    // surface. Listing it as unsupported deleted the flag and silently revived
    // the interactive approval wait for unattended runs (2026-07-22 incident).
    ['chatId', 'channelType', 'tenantId', 'sessionId', 'userId', 'agentId', 'permissionLevel', 'scopeGrants', 'abortSignal', 'taskId', 'onArtifact', 'executionModel', 'systemPrompt', 'turnOrigin'],
    [
      'artifactHints',
      'turnRichArtifactPaths',
      'artifactCoordinator',
      'permissionElevationRequests',
      'writeConfirmedByElevation',
      'originalRequest',
      'planDeliveryMode',
    ],
  ),
  subagent_fallback: declaration(
    ['chatId', 'tenantId', 'agentId', 'permissionLevel', 'taskId', 'systemPrompt'],
    [
      'channelType',
      'sessionId',
      'userId',
      'scopeGrants',
      'abortSignal',
      'onArtifact',
      'artifactHints',
      'turnRichArtifactPaths',
      'artifactCoordinator',
      'permissionElevationRequests',
      'writeConfirmedByElevation',
      'executionModel',
      'originalRequest',
      'planDeliveryMode',
      'turnOrigin',
    ],
  ),
  background_job: declaration(
    ['abortSignal'],
    [
      'chatId',
      'channelType',
      'tenantId',
      'sessionId',
      'userId',
      'agentId',
      'permissionLevel',
      'scopeGrants',
      'taskId',
      'onArtifact',
      'artifactHints',
      'turnRichArtifactPaths',
      'artifactCoordinator',
      'permissionElevationRequests',
      'writeConfirmedByElevation',
      'executionModel',
      'systemPrompt',
      'originalRequest',
      'planDeliveryMode',
      'turnOrigin',
    ],
  ),
  recovery: declaration(
    [],
    [...EXECUTION_CONTEXT_FIELDS],
  ),
  proactive: declaration(
    ['tenantId'],
    [
      'chatId',
      'channelType',
      'sessionId',
      'userId',
      'agentId',
      'permissionLevel',
      'scopeGrants',
      'abortSignal',
      'taskId',
      'onArtifact',
      'artifactHints',
      'turnRichArtifactPaths',
      'artifactCoordinator',
      'permissionElevationRequests',
      'writeConfirmedByElevation',
      'executionModel',
      'systemPrompt',
      'originalRequest',
      'planDeliveryMode',
      'turnOrigin',
    ],
  ),
};

export function buildExecutionToolContext(
  surface: ExecutionSurface,
  inputs: Partial<ToolContext>,
): ToolContext {
  const declarationForSurface = SURFACE_CONTEXT_DECLARATIONS[surface];
  const context: ToolContext = { ...inputs };

  for (const key of declarationForSurface.unsupported) {
    delete context[key];
  }

  context.executionContext = {
    surface,
    unsupported: [...declarationForSurface.unsupported],
  };

  return context;
}
