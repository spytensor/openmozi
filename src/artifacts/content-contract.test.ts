import { describe, expect, it } from 'vitest';
import {
  explicitlyRequestedArtifactContentType,
  explicitlyRequestsRenderableArtifact,
  inferStrongArtifactContentType,
  normalizeArtifactContentType,
} from './content-contract.js';

describe('artifact content contract', () => {
  it('extracts concrete types from explicit user requests', () => {
    expect(explicitlyRequestedArtifactContentType('给我一个 HTML，做一个？')).toBe('html');
    expect(explicitlyRequestedArtifactContentType('直接生成 SVG 图表')).toBe('svg');
    expect(explicitlyRequestsRenderableArtifact('做一个 dashboard HTML？')).toBe(true);
  });

  it('promotes only strong standalone HTML signatures out of markdown', () => {
    const html = '<!DOCTYPE html><html><body><h1>Dashboard</h1></body></html>';
    expect(inferStrongArtifactContentType(html)).toBe('html');
    expect(normalizeArtifactContentType('markdown', html)).toBe('html');
    expect(normalizeArtifactContentType('document', html)).toBe('html');
    expect(normalizeArtifactContentType('markdown', '<div>valid inline HTML in Markdown</div>')).toBe('markdown');
  });

  it('promotes standalone SVG while preserving explicit code types', () => {
    expect(normalizeArtifactContentType('markdown', '<svg viewBox="0 0 10 10"></svg>')).toBe('svg');
    expect(normalizeArtifactContentType('react', '<html><body>literal in JSX</body></html>')).toBe('react');
  });
});
