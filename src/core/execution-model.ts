import type { ModelThinkSetting } from './llm.js';

/** Immutable model selection captured when an interactive turn starts. */
export interface ExecutionModelSnapshot {
  provider: string;
  model: string;
  think?: ModelThinkSetting;
}

export function isExecutionModelSnapshot(value: unknown): value is ExecutionModelSnapshot {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.provider === 'string'
    && candidate.provider.length > 0
    && typeof candidate.model === 'string'
    && candidate.model.length > 0;
}
