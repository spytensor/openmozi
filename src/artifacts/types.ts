export type ArtifactStatus = 'running' | 'completed' | 'failed' | 'closed';

export interface ArtifactEnvelope {
  id: string;
  plugin_id: string;
  title: string;
  status: ArtifactStatus;
  collapsed_by_default: boolean;
  fallback_text: string;
  data: Record<string, unknown>;
  updated_at: string;
  persisted_path?: string;
  parent_id?: string;
  version_number?: number;
  change_description?: string;
}

export interface ArtifactPatch {
  /**
   * Optional reclassification. The live streaming tracker pre-opens artifacts
   * as `live_work_v1` before the real renderer is known; the completion patch
   * carries the authoritative plugin_id so persistence and UI converge on the
   * same renderer regardless of whether the provider streamed tool input.
   */
  plugin_id?: string;
  title?: string;
  status?: ArtifactStatus;
  fallback_text?: string;
  data?: Record<string, unknown>;
  updated_at?: string;
  persisted_path?: string;
  parent_id?: string;
  version_number?: number;
  change_description?: string;
}

export type ArtifactEvent =
  | { type: 'open'; artifact: ArtifactEnvelope }
  | { type: 'patch'; artifactId: string; patch: ArtifactPatch }
  | { type: 'close'; artifactId: string };

export function createArtifactId(prefix = 'artifact'): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
