import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, removeTempDir } from '../test-helpers.js';
import { extractPersistedArtifactSummary } from './context-history.js';

let tmpDir: string;
let artifactCounter = 0;

function writePersistedArtifact(content: string): string {
  const dir = join(tmpDir, `artifact-${++artifactCounter}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'draft.md');
  writeFileSync(path, content, 'utf-8');
  return path;
}

function persistedArtifactJson(path: string, fallbackText = 'Compact fallback summary'): string {
  return JSON.stringify({
    _artifact: true,
    id: 'artifact_ctx_1',
    plugin_id: 'document_v1',
    title: 'Iteration Draft',
    status: 'completed',
    collapsed_by_default: false,
    fallback_text: fallbackText,
    data: { content_type: 'markdown' },
    updated_at: new Date().toISOString(),
    persisted_path: path,
    version_number: 4,
  });
}

beforeAll(() => {
  tmpDir = createTempDir();
  process.env.MOZI_WORKSPACES = join(tmpDir, 'user-workspaces');
});

afterAll(() => {
  delete process.env.MOZI_WORKSPACES;
  removeTempDir(tmpDir);
});

describe('memory/context-history persisted artifact summaries', () => {
  it('injects full persisted artifact content when the file fits the budget', () => {
    const content = [
      '# Iteration Draft',
      'Paragraph one must remain visible.',
      'Paragraph two is the section to edit.',
      'Paragraph three must remain visible.',
    ].join('\n\n');
    const persistedPath = writePersistedArtifact(content);

    const summary = extractPersistedArtifactSummary(persistedArtifactJson(persistedPath), {
      contentCharLimit: 4000,
      remainingTokenBudget: 2000,
    });

    expect(summary).not.toBeNull();
    expect(summary).toContain(`[Full content from v4 — ${content.length} chars injected for iteration context]`);
    expect(summary).toContain(content);
    expect(summary).not.toContain('[Content truncated');
  });

  it('falls back to compact 160-character summary when remaining token budget is below guard', () => {
    const content = [
      '# Budget Guard Draft',
      'FULL_CONTENT_SHOULD_NOT_BE_INJECTED',
      'Another paragraph that should stay out of context in low budget mode.',
    ].join('\n\n');
    const persistedPath = writePersistedArtifact(content);
    const fallbackText = `${'compact fallback '.repeat(20)}tail`;

    const summary = extractPersistedArtifactSummary(persistedArtifactJson(persistedPath, fallbackText), {
      contentCharLimit: 4000,
      remainingTokenBudget: 499,
    });

    expect(summary).not.toBeNull();
    expect(summary).toContain('[Artifact: Iteration Draft (markdown)]');
    expect(summary).toContain('compact fallback');
    expect(summary).not.toContain('[Full content from v4');
    expect(summary).not.toContain('FULL_CONTENT_SHOULD_NOT_BE_INJECTED');
    expect(summary!.length).toBeLessThanOrEqual('[Artifact: Iteration Draft (markdown)] '.length + 160);
  });

  it('falls back to compact 160-character summary when persisted_path is missing', () => {
    const missingPath = join(tmpDir, 'missing', 'draft.md');
    const fallbackText = `${'missing file fallback '.repeat(20)}tail`;
    let summary: string | null = null;

    expect(() => {
      summary = extractPersistedArtifactSummary(persistedArtifactJson(missingPath, fallbackText), {
        contentCharLimit: 4000,
        remainingTokenBudget: 2000,
      });
    }).not.toThrow();

    expect(summary).not.toBeNull();
    expect(summary).toContain('[Artifact: Iteration Draft (markdown)]');
    expect(summary).toContain('missing file fallback');
    expect(summary).not.toContain('[Full content from v4');
    expect(summary!.length).toBeLessThanOrEqual('[Artifact: Iteration Draft (markdown)] '.length + 160);
  });
});
