/**
 * Deliverable existence verification — a runtime fact check against fabricated
 * completion claims.
 *
 * MOZI's completion is otherwise driven by the Brain's own final text. A weaker
 * scheduler model can (and did) report "PPT 已生成并完成内容校验。文件：
 * output/GPT-5.6_模型介绍.pptx（209KB，9页）" for a file that was never written —
 * the runtime trusted the narration. This module makes the substrate, not the
 * model, the arbiter of "did the claimed file actually get produced": it scans
 * the final message for concrete deliverable-file references and checks they
 * exist (non-empty) on disk. Missing references are surfaced so the completion
 * gate can convert a fabricated success into an honest failure.
 *
 * Deliberately conservative to avoid false positives: only tokens ending in a
 * "hard deliverable" extension (decks/docs/sheets/archives) are checked. A
 * relative claim must resolve to the exact path it names under output/workspace;
 * an unrelated same-basename file is not evidence that the claim is true.
 */

import { existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { getOutputDir, getWorkspaceDir, isPathInsideRoot } from '../tools/workspace-policy.js';

/**
 * Extensions that represent a produced binary/bundled deliverable — the class
 * of file a completion message claims to have "generated". Excludes md/txt,
 * source code, and images, which are referenced innocuously far more often than
 * they are fabricated.
 */
const HARD_DELIVERABLE_EXTENSIONS = new Set([
  'pptx', 'key',
  'docx', 'pdf', 'rtf',
  'xlsx', 'csv', 'tsv',
  'zip', 'tar', 'gz', 'tgz',
  'epub',
]);

function extOf(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot >= 0 ? path.slice(dot + 1).toLowerCase() : '';
}

/**
 * Pull concrete deliverable-file references out of a final assistant message.
 * Matches backtick-quoted tokens and bare path-like tokens that end in a hard
 * deliverable extension. Bare tokens must contain a path separator so a passing
 * mention of a generic filename is not treated as a delivery claim.
 */
export function extractClaimedDeliverablePaths(text: string): string[] {
  if (!text) return [];
  const found = new Set<string>();

  // `output/foo.pptx` — backtick-quoted references (the common delivery form).
  for (const match of text.matchAll(/`([^`\n]{1,240})`/g)) {
    const token = match[1].trim();
    if (HARD_DELIVERABLE_EXTENSIONS.has(extOf(token))) found.add(token);
  }

  // Bare path tokens containing a separator, e.g. output/foo.pptx (no backticks).
  for (const match of text.matchAll(/([^\s`'"()（）【】,，。;；]+\/[^\s`'"()（）【】,，。;；]*\.[A-Za-z0-9]+)/g)) {
    const token = match[1].trim();
    if (HARD_DELIVERABLE_EXTENSIONS.has(extOf(token))) found.add(token);
  }

  return [...found];
}

function existsNonEmpty(candidate: string): boolean {
  try {
    if (!existsSync(candidate)) return false;
    const stats = statSync(candidate);
    return stats.isFile() && stats.size > 0;
  } catch {
    return false;
  }
}

function existsNonEmptyInsideRoot(candidate: string, root: string): boolean {
  try {
    const canonicalRoot = realpathSync(root);
    const canonicalCandidate = realpathSync(candidate);
    return isPathInsideRoot(canonicalCandidate, canonicalRoot) && existsNonEmpty(canonicalCandidate);
  } catch {
    return false;
  }
}

/** Resolve a claimed path exactly; do not let a same-name decoy satisfy it. */
function isDeliverablePresent(claimed: string, userId?: string | null): boolean {
  const outputDir = getOutputDir();
  const workspaceDir = getWorkspaceDir(userId ?? undefined);
  if (isAbsolute(claimed)) return existsNonEmpty(resolve(claimed));

  const normalized = claimed.replace(/^\.\//, '');
  const outputMatch = normalized.match(/^output[/\\](.+)$/);
  const workspaceMatch = normalized.match(/^workspace[/\\](.+)$/);
  const root = outputMatch ? outputDir : workspaceDir;
  const relativePath = outputMatch?.[1] ?? workspaceMatch?.[1] ?? normalized;
  const candidate = resolve(root, relativePath);
  if (!isPathInsideRoot(candidate, root)) return false;
  return existsNonEmptyInsideRoot(candidate, root);
}

/**
 * Return the subset of deliverable paths a message claims that do NOT exist on
 * disk. An empty array means every claimed deliverable is real (or none were
 * claimed).
 */
export function findMissingClaimedDeliverables(text: string, userId?: string | null): string[] {
  const claimed = extractClaimedDeliverablePaths(text);
  if (claimed.length === 0) return [];
  return claimed.filter((path) => !isDeliverablePresent(path, userId));
}
