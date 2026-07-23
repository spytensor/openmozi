import { describe, expect, it } from 'vitest';
import { encodeArtifactMarker, isArtifactMarker, parseArtifactMarker } from './marker.js';

describe('artifacts/marker', () => {
  it('encodes and decodes artifact markers', () => {
    const artifact = {
      id: 'artifact_1',
      plugin_id: 'workspace_hub_v1',
      title: 'Workspace',
      status: 'running',
      collapsed_by_default: false,
      fallback_text: 'fallback',
      data: { mission: { progress: 20 } },
      updated_at: new Date().toISOString(),
    } as const;

    const encoded = encodeArtifactMarker(artifact);
    expect(isArtifactMarker(encoded)).toBe(true);
    const decoded = parseArtifactMarker(encoded);
    expect(decoded).toEqual(artifact);
  });

  it('returns null for malformed marker payload', () => {
    expect(parseArtifactMarker('[MOZI_ARTIFACT_V1]not-json')).toBeNull();
    expect(parseArtifactMarker('plain text')).toBeNull();
  });

  it('rejects a marker whose status is not a known ArtifactStatus', () => {
    const bogus = {
      id: 'artifact_bad',
      plugin_id: 'workspace_hub_v1',
      title: 'Bad status',
      status: 'in_progress', // not one of running|completed|failed|closed
      collapsed_by_default: false,
      fallback_text: 'fallback',
      data: { mission: { progress: 10 } },
      updated_at: new Date().toISOString(),
    };
    const encoded = `[MOZI_ARTIFACT_V1]${JSON.stringify(bogus)}`;
    expect(isArtifactMarker(encoded)).toBe(true);
    expect(parseArtifactMarker(encoded)).toBeNull();
  });

  it('parses markers with leading whitespace and still detects them as markers', () => {
    const artifact = {
      id: 'artifact_ws',
      plugin_id: 'workspace_hub_v1',
      title: 'Execution Workspace',
      status: 'completed',
      collapsed_by_default: true,
      fallback_text: 'fallback',
      data: { mission: { progress: 100 } },
      updated_at: new Date().toISOString(),
    } as const;

    const encoded = encodeArtifactMarker(artifact);
    const padded = `\n  ${encoded}`;
    expect(isArtifactMarker(padded)).toBe(true);
    expect(parseArtifactMarker(padded)).toEqual(artifact);
  });
});
