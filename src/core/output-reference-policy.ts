export interface SandboxReferenceSanitization {
  content: string;
  rejectedCount: number;
}

/**
 * Reject provider-specific `sandbox:` links from assistant-visible output.
 * MOZI has no resolver for that scheme; leaving one in live output or durable
 * history is a false pointer. Labels remain plain text and the real artifact
 * card remains the supported open/download surface.
 */
export function rejectUnsupportedSandboxReferences(content: string): SandboxReferenceSanitization {
  let rejectedCount = 0;
  let sanitized = content.replace(
    /\[([^\]\n]{1,240})\]\(\s*<?sandbox:[^)\n>]+>?\s*\)/gi,
    (_match, label: string) => {
      rejectedCount += 1;
      return label.trim();
    },
  );
  sanitized = sanitized.replace(/`?<?sandbox:[^\s`<>()\[\]{},，。;；!?！？]*>?`?/gi, () => {
    rejectedCount += 1;
    return '[unsupported artifact link removed]';
  });
  sanitized = sanitized.trim();
  if (rejectedCount === 0) return { content: sanitized, rejectedCount };

  const note = /[\u3400-\u4dbf\u4e00-\u9fff]/.test(sanitized)
    ? '运行时说明：已移除 MOZI 无法解析的 sandbox 链接；请使用本会话中的产物卡片。'
    : 'Runtime note: unsupported sandbox links were removed; use the artifact cards in this conversation.';
  return { content: `${sanitized}\n\n${note}`.trim(), rejectedCount };
}
