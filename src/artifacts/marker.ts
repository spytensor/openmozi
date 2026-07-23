import { z } from 'zod';
import type { ArtifactEnvelope } from './types.js';

export const ARTIFACT_MARKER_PREFIX = '[MOZI_ARTIFACT_V1]';

/**
 * Runtime shape check for a decoded artifact envelope. `status` is constrained
 * to the known {@link ArtifactStatus} union so a marker carrying an arbitrary
 * status string is rejected rather than passed through as a fabricated-but-valid
 * envelope.
 */
const artifactEnvelopeSchema = z.object({
  id: z.string(),
  plugin_id: z.string(),
  title: z.string(),
  status: z.enum(['running', 'completed', 'failed', 'closed']),
  collapsed_by_default: z.boolean(),
  fallback_text: z.string(),
  data: z.record(z.string(), z.unknown()),
  updated_at: z.string(),
  persisted_path: z.string().optional(),
  parent_id: z.string().optional(),
  version_number: z.number().optional(),
  change_description: z.string().optional(),
});

export function encodeArtifactMarker(artifact: ArtifactEnvelope): string {
  return `${ARTIFACT_MARKER_PREFIX}${JSON.stringify(artifact)}`;
}

export function parseArtifactMarker(content: string): ArtifactEnvelope | null {
  const normalized = content.trimStart();
  if (!normalized.startsWith(ARTIFACT_MARKER_PREFIX)) {
    return null;
  }

  const raw = normalized.slice(ARTIFACT_MARKER_PREFIX.length).trim();
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as unknown;
    const result = artifactEnvelopeSchema.safeParse(parsed);
    if (!result.success) return null;
    return result.data as ArtifactEnvelope;
  } catch {
    return null;
  }
}

export function isArtifactMarker(content: string): boolean {
  return content.trimStart().startsWith(ARTIFACT_MARKER_PREFIX);
}
