export type RenderableArtifactContentType = 'html' | 'svg' | 'react' | 'javascript' | 'markdown';

const GENERIC_ARTIFACT_REQUEST = /\b(svg|html|react|javascript|chart|graph|diagram|visualization|visualisation|artifact|widget|component|page)\b|图表|示意图|流程图|架构图|关系图|对比图|可视化|组件|页面|网页|做个图|画个图/i;

/** Returns the concrete renderable type explicitly named by the user. */
export function explicitlyRequestedArtifactContentType(text: string): RenderableArtifactContentType | null {
  if (/\bhtml\b|HTML\s*(?:页面|网页|报告)|网页/i.test(text)) return 'html';
  if (/\bsvg\b/i.test(text)) return 'svg';
  if (/\breact\b|React\s*组件/i.test(text)) return 'react';
  if (/\bjavascript\b|\bvanilla[- ]?js\b/i.test(text)) return 'javascript';
  return null;
}

export function explicitlyRequestsRenderableArtifact(text: string): boolean {
  return GENERIC_ARTIFACT_REQUEST.test(text);
}

/**
 * Detect only unambiguous standalone markup signatures. Markdown legitimately
 * permits inline HTML, so ordinary tags such as <div> are deliberately not
 * promoted to an HTML artifact.
 */
export function inferStrongArtifactContentType(content: string): 'html' | 'svg' | null {
  const value = content.replace(/^\uFEFF/, '').trimStart();
  if (/^(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/i.test(value)) return 'svg';
  if (/^<!doctype\s+html(?:\s|>)/i.test(value) || /^<html(?:\s|>)/i.test(value)) return 'html';
  return null;
}

export function normalizeArtifactContentType(
  requestedContentType: string,
  content: string,
): RenderableArtifactContentType {
  const requested = requestedContentType.toLowerCase() === 'document'
    ? 'markdown'
    : requestedContentType.toLowerCase();
  const inferred = inferStrongArtifactContentType(content);
  if (inferred && requested === 'markdown') return inferred;
  if (requested === 'html' || requested === 'svg' || requested === 'react' || requested === 'javascript' || requested === 'markdown') {
    return requested;
  }
  return 'markdown';
}
