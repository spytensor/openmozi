/**
 * Repair GFM tables that a model emitted with structurally-invalid markup.
 *
 * remark-gfm only parses a table when it is well-formed: the header, a
 * `---` separator whose column count MATCHES the header, and rows that are
 * pipe-delimited on their own lines. Cheaper/faster models are sloppy and
 * produce two failure modes we see in practice:
 *
 *   1. Collapsed onto one physical line (row newlines flattened to spaces):
 *        | A | B | | --- | --- | | 1 | 2 |
 *
 *   2. Multi-line but malformed — the separator column count does not match
 *      the header, and/or data rows are missing their leading pipe:
 *        | 模型 | 发布 | 特性 |
 *        |---|---|                     <- 2 cols for a 3-col header
 *         **GPT-5.4** | 3月5日 | ...    <- no leading pipe
 *
 * Either way remark-gfm falls back to rendering raw pipe text. This module
 * repairs both before the markdown reaches ReactMarkdown. Well-formed tables
 * and prose with stray pipes pass through unchanged.
 */

/** A cell that is only dashes with optional leading/trailing colon (GFM separator). */
const SEPARATOR_CELL = /^:?-{2,}:?$/;

/** A whole line that is a table separator: pipes, dashes, colons, spaces, with at least one dash. */
const SEPARATOR_LINE = /^[\s|:-]*-{2,}[\s|:-]*$/;

/** Split a pipe row into trimmed cells. */
function splitCells(line: string): string[] {
  return line.trim().split("|").map((c) => c.trim());
}

/** Cells of a row, dropping the empty artifacts from leading/trailing pipes. */
function rowCells(line: string): string[] {
  const cells = splitCells(line);
  if (cells.length && cells[0] === "") cells.shift();
  if (cells.length && cells[cells.length - 1] === "") cells.pop();
  return cells;
}

/** Build a well-formed GFM row line from cells. */
function toRow(cells: string[]): string {
  return `| ${cells.join(" | ")} |`;
}

/** Build a separator line for a given column count. */
function toSeparator(columns: number): string {
  return `| ${Array.from({ length: columns }, () => "---").join(" | ")} |`;
}

/** True when a single physical line is a collapsed table (inline separator run after a header). */
function looksCollapsed(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return false;
  const cells = splitCells(trimmed);
  const firstSep = cells.findIndex((c) => SEPARATOR_CELL.test(c));
  if (firstSep <= 0) return false;
  const afterSep = cells.slice(firstSep).filter((c) => !SEPARATOR_CELL.test(c) && c.length > 0);
  return afterSep.length > 0;
}

/** Rebuild one collapsed line into multi-line GFM using empty-cell row boundaries. */
function rebuildCollapsed(line: string): string {
  const raw = splitCells(line);
  const groups: string[][] = [];
  let current: string[] = [];
  for (const cell of raw) {
    if (cell.length === 0) {
      if (current.length > 0) { groups.push(current); current = []; }
      continue;
    }
    current.push(cell);
  }
  if (current.length > 0) groups.push(current);

  if (groups.length < 2 || !groups[1].every((c) => SEPARATOR_CELL.test(c))) return line;

  const columns = groups[0].length;
  const rows = [groups[0], ...groups.slice(2)];
  const out = [toRow(groups[0]), toSeparator(columns), ...rows.slice(1).map(toRow)];
  return `\n${out.join("\n")}\n`;
}

/** A line that carries table data: has a pipe and is not itself a separator line. */
function isTableDataLine(line: string): boolean {
  return line.includes("|") && !SEPARATOR_LINE.test(line.trim());
}

/**
 * Repair a multi-line table starting at `headerIdx` (its next line is a
 * separator). Returns the repaired lines and the index after the table.
 */
function repairMultiline(lines: string[], headerIdx: number): { block: string[]; next: number } {
  const header = rowCells(lines[headerIdx]);
  const columns = header.length;
  const block: string[] = [toRow(header), toSeparator(columns)];

  let i = headerIdx + 2; // skip header + separator
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") break; // blank line ends the table
    if (!isTableDataLine(line)) break; // non-row line ends the table
    block.push(toRow(rowCells(line)));
  }
  return { block, next: i };
}

/** Normalize collapsed and malformed GFM tables in a markdown string. */
export function normalizeMarkdownTables(markdown: string): string {
  if (!markdown.includes("|")) return markdown;
  const lines = markdown.split("\n");
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Case 1: whole table collapsed onto one line.
    if (looksCollapsed(line)) {
      out.push(rebuildCollapsed(line));
      continue;
    }

    // Case 2: multi-line table whose header is followed by a separator line.
    const next = lines[i + 1];
    if (line.includes("|") && next !== undefined && SEPARATOR_LINE.test(next.trim()) && next.includes("|")) {
      const { block, next: after } = repairMultiline(lines, i);
      out.push(...block);
      i = after - 1;
      continue;
    }

    out.push(line);
  }

  return out.join("\n");
}
