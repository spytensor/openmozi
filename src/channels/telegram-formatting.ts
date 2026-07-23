/**
 * Telegram Formatting — markdown/HTML conversion for Telegram messages.
 *
 * Pure text transformation functions with no Telegram API calls.
 * Used by telegram.ts and telegram-progress.ts.
 */

/** Telegram message size limit */
export const TELEGRAM_MAX_LENGTH = 4096;

/**
 * Convert markdown tables into plain-text list format for Telegram.
 * Uses the header row as labels: "Header1: Cell1 | Header2: Cell2"
 */
export function convertMarkdownTables(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    // Detect table: current line starts with |, next line is separator |---|
    if (
      lines[i].trimStart().startsWith('|') &&
      i + 1 < lines.length &&
      /^\s*\|[\s:]*-{2,}/.test(lines[i + 1])
    ) {
      const headers = parseTableRow(lines[i]);
      i += 2; // skip header + separator

      // Process data rows
      while (i < lines.length && lines[i].trimStart().startsWith('|')) {
        const cells = parseTableRow(lines[i]);
        const parts: string[] = [];
        for (let c = 0; c < cells.length; c++) {
          if (cells[c]) {
            parts.push(headers[c] ? `${headers[c]}: ${cells[c]}` : cells[c]);
          }
        }
        if (parts.length > 0) {
          result.push(parts.join('  |  '));
        }
        i++;
      }
    } else {
      result.push(lines[i]);
      i++;
    }
  }

  return result.join('\n');
}

/** Parse a markdown table row into trimmed cell values. */
function parseTableRow(line: string): string[] {
  return line.split('|').map(c => c.trim()).filter((_, idx, arr) => idx > 0 && idx < arr.length - 1);
}

/**
 * Strip markdown to plain text (fallback when HTML rendering fails).
 */
export function normalizeTelegramText(text: string): string {
  if (!text) return '';

  let normalized = text.replace(/\r\n/g, '\n');

  // Markdown links -> "label (url)"
  normalized = normalized.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)');

  // Remove fenced code markers but keep content
  normalized = normalized.replace(/```[a-zA-Z0-9_-]*\n?/g, '');
  normalized = normalized.replace(/```/g, '');

  // Convert markdown tables to readable plain text
  normalized = convertMarkdownTables(normalized);

  // Remove heading markers
  normalized = normalized.replace(/^\s{0,3}#{1,6}\s+/gm, '');

  // Remove horizontal rules
  normalized = normalized.replace(/^\s*[-*_]{3,}\s*$/gm, '');

  // Normalize list markers
  normalized = normalized.replace(/^\s*[*+]\s+/gm, '- ');

  // Remove paired emphasis wrappers
  normalized = normalized.replace(/\*\*([^*\n]+)\*\*/g, '$1');
  normalized = normalized.replace(/__([^_\n]+)__/g, '$1');
  normalized = normalized.replace(/\*([^*\n]+)\*/g, '$1');
  normalized = normalized.replace(/_([^_\n]+)_/g, '$1');

  // Remove inline-code wrappers
  normalized = normalized.replace(/`([^`\n]+)`/g, '$1');
  normalized = normalized.replace(/`/g, '');

  // Collapse extra blank lines
  normalized = normalized.replace(/\n{3,}/g, '\n\n').trim();

  return normalized.length > 0 ? normalized : text.trim();
}

/**
 * Convert Markdown to Telegram-compatible HTML.
 *
 * Telegram supports: <b>, <i>, <code>, <pre>, <a>, <s>, <u>
 * Does NOT support: tables, headings, horizontal rules — converted to plain text.
 */
export function markdownToTelegramHtml(text: string): string {
  if (!text) return '';

  let html = text.replace(/\r\n/g, '\n');

  // ── Structural elements Telegram can't render → plain text ──
  html = convertMarkdownTables(html);
  html = html.replace(/^\s*[-*_]{3,}\s*$/gm, '');                  // horizontal rules → remove

  // ── Extract headings to protect from HTML escaping ──
  const headings: string[] = [];
  html = html.replace(/^\s{0,3}#{1,6}\s+(.+)$/gm, (_match, content: string) => {
    const idx = headings.length;
    headings.push(content);
    return `\x00HEADING_${idx}\x00`;
  });

  // ── Extract fenced code blocks to protect from HTML escaping ──
  const codeBlocks: string[] = [];
  html = html.replace(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g, (_match, code: string) => {
    const idx = codeBlocks.length;
    codeBlocks.push(code.replace(/\n$/, ''));
    return `\x00CODEBLOCK_${idx}\x00`;
  });
  html = html.replace(/```([\s\S]*?)```/g, (_match, code: string) => {
    const idx = codeBlocks.length;
    codeBlocks.push(code.replace(/\n$/, ''));
    return `\x00CODEBLOCK_${idx}\x00`;
  });

  // ── Extract inline code to protect from HTML escaping ──
  const inlineCodes: string[] = [];
  html = html.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    const idx = inlineCodes.length;
    inlineCodes.push(code);
    return `\x00INLINE_${idx}\x00`;
  });

  // ── HTML-escape remaining text ──
  html = html.replace(/&/g, '&amp;');
  html = html.replace(/</g, '&lt;');
  html = html.replace(/>/g, '&gt;');

  // ── Restore headings as bold ──
  html = html.replace(/\x00HEADING_(\d+)\x00/g, (_match, idx: string) => {
    const content = headings[Number(idx)]
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<b>${content}</b>`;
  });

  // ── Restore code blocks with HTML tags (content is escaped separately) ──
  html = html.replace(/\x00CODEBLOCK_(\d+)\x00/g, (_match, idx: string) => {
    const code = codeBlocks[Number(idx)]
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<pre>${code}</pre>`;
  });
  html = html.replace(/\x00INLINE_(\d+)\x00/g, (_match, idx: string) => {
    const code = inlineCodes[Number(idx)]
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<code>${code}</code>`;
  });

  // ── Markdown formatting → HTML tags ──
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  html = html.replace(/__([^_\n]+)__/g, '<b>$1</b>');
  html = html.replace(/\*([^*\n]+)\*/g, '<i>$1</i>');
  html = html.replace(/_([^_\n]+)_/g, '<i>$1</i>');
  html = html.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');

  // Markdown links → HTML links
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');

  // Normalize list markers
  html = html.replace(/^\s*[*+]\s+/gm, '- ');

  // Collapse extra blank lines
  html = html.replace(/\n{3,}/g, '\n\n');

  return html.trim();
}

/**
 * Split a long message into chunks that fit within Telegram's 4096 char limit.
 * Tries to split at newlines for readability.
 */
export function splitMessage(text: string, maxLength = TELEGRAM_MAX_LENGTH): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to find a good split point (newline) within the limit
    let splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt <= 0 || splitAt < maxLength * 0.5) {
      // No good newline split — try space
      splitAt = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitAt <= 0) {
      // Hard split at limit
      splitAt = maxLength;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}
