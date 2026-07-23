import { createReadStream, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readdir, lstat, realpath } from 'node:fs/promises';
import { basename, extname, relative, resolve } from 'node:path';
import pino from 'pino';
import type { ArtifactCoordinator } from './coordinator.js';
import {
  getOutputDir,
  getWorkspaceAllowedRoots,
  getWorkspaceDir,
  isPathInsideRoot,
} from '../tools/workspace-policy.js';
import { deliverableRegistry } from '../store/deliverables.js';
import { deliverableVersionStore } from '../store/deliverable-versions.js';
import { buildFileArtifactPreviewFields } from './file-preview.js';

const logger = pino({ name: 'mozi:file-artifacts' });

export type FileArtifactKind =
  | 'deck'
  | 'document'
  | 'sheet'
  | 'image'
  | 'archive'
  | 'code'
  | 'other';

/**
 * Whether a produced file is the thing the user asked for, or working material
 * produced on the way to it. `supporting` files stay durable and reachable —
 * they are collapsed in the timeline, never dropped.
 */
export type FileArtifactRole = 'primary' | 'supporting';

export interface FileArtifactData {
  path: string;
  filename: string;
  ext: string;
  size: number;
  mime: string;
  kind: FileArtifactKind;
  previewable: boolean;
  previewUrl?: string;
  downloadUrl: string;
  skillName?: string;
  /** Absent means primary; only set when a turn produced a clear deliverable. */
  role?: FileArtifactRole;
  /**
   * The carded file vanished from disk after emission (deliverable-shelf
   * liveness sweep, operator decision 2026-07-19). Disk is the render truth:
   * the card must say so instead of 404ing on open. ALWAYS written as an
   * explicit boolean on every emission/patch: both the timeline store and
   * the client MERGE patch data over existing data, so an absent key can
   * never clear a persisted `true` — key-deletion clearing lied in the
   * opposite direction (review finding, 2026-07-19).
   */
  missing?: boolean;
}

interface CandidateFile {
  data: FileArtifactData;
  mtimeMs: number;
  ctimeMs: number;
  /** Which scan root produced the candidate — minting policy is keyed on it. */
  rootKind: ScanRoot['kind'];
}

interface FileFingerprint {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface EmittedFile {
  artifactId: string;
  fingerprint: FileFingerprint;
  contentKey: string;
  /** Kept so an artifact emitted before the turn's deliverable existed can be demoted later. */
  data: FileArtifactData;
}

interface ContentArtifact {
  artifactId: string;
  candidate: CandidateFile;
}

interface ScanRoot {
  path: string;
  /** Who owns the root: MOZI's delivery dir, MOZI's scratch dir, or the user's project. */
  kind: 'output' | 'workspace' | 'project';
}

export interface TurnFileArtifactTracker {
  captureBaseline(): Promise<void>;
  noteSkillUse(skillName: string): void;
  scanAndEmit(): Promise<void>;
  emitPaths(paths: readonly string[]): Promise<void>;
}

interface TurnFileArtifactTrackerOptions {
  activeRootPath?: string;
  tenantId?: string;
  sessionId?: string;
  userId?: string;
  artifactCoordinator?: ArtifactCoordinator;
  richArtifactPaths?: ReadonlySet<string>;
  /**
   * The artifact already published for a path by an earlier turn of this
   * session, if any. Injected rather than queried here so this module keeps no
   * database dependency and stays testable without one.
   */
  resolvePublishedArtifactId?: (absPath: string) => string | null;
}

export const DECK_EXTENSIONS = new Set(['pptx', 'key']);
export const DOCUMENT_EXTENSIONS = new Set(['docx', 'pdf', 'md', 'txt', 'rtf']);
export const SHEET_EXTENSIONS = new Set(['xlsx', 'csv', 'tsv']);
export const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);
export const ARCHIVE_EXTENSIONS = new Set(['zip', 'tar', 'gz', 'tgz']);
export const CODE_EXTENSIONS = new Set([
  'js',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'jsx',
  'py',
  'json',
  'jsonl',
  'yaml',
  'yml',
  'toml',
  'xml',
  'html',
  'htm',
  'css',
  'scss',
  'sass',
  'less',
  'sh',
  'bash',
  'zsh',
  'sql',
  'go',
  'rs',
  'rb',
  'php',
  'swift',
  'kt',
  'kts',
  'java',
  'c',
  'h',
  'cpp',
  'cc',
  'cxx',
  'hpp',
  'cs',
  'lua',
  'r',
  'scala',
  'dart',
  'vue',
  'svelte',
]);
export const OTHER_DELIVERABLE_EXTENSIONS = new Set(['epub']);

/**
 * Top-level workspace subdirectories MOZI owns. Skipped only under a
 * `workspace` root — a user project may legitimately hold a `tasks/` or
 * `users/` directory, and those are theirs to see.
 */
const WORKSPACE_INTERNAL_DIRS = new Set([
  'tasks',
  'users',
  'agents',
  'skills',
  'artifacts',
  'path',
]);

const SKIPPED_DIRECTORY_NAMES = new Set([
  'node_modules',
  'bower_components',
  'jspm_packages',
  '__pycache__',
  'tmp',
  'temp',
  'cache',
  'target',
  'build',
  'dist',
  'out',
  'coverage',
]);

const MIME_BY_EXT: Record<string, string> = {
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  key: 'application/vnd.apple.keynote',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  md: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  rtf: 'application/rtf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv; charset=utf-8',
  tsv: 'text/tab-separated-values; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  zip: 'application/zip',
  tar: 'application/x-tar',
  gz: 'application/gzip',
  tgz: 'application/gzip',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  cjs: 'text/javascript; charset=utf-8',
  ts: 'text/typescript; charset=utf-8',
  tsx: 'text/typescript; charset=utf-8',
  jsx: 'text/javascript; charset=utf-8',
  py: 'text/x-python; charset=utf-8',
  json: 'application/json; charset=utf-8',
  jsonl: 'application/x-ndjson; charset=utf-8',
  yaml: 'application/yaml; charset=utf-8',
  yml: 'application/yaml; charset=utf-8',
  toml: 'application/toml; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  scss: 'text/x-scss; charset=utf-8',
  sass: 'text/x-sass; charset=utf-8',
  less: 'text/css; charset=utf-8',
  sh: 'text/x-shellscript; charset=utf-8',
  bash: 'text/x-shellscript; charset=utf-8',
  zsh: 'text/x-shellscript; charset=utf-8',
  sql: 'application/sql; charset=utf-8',
  go: 'text/x-go; charset=utf-8',
  rs: 'text/rust; charset=utf-8',
  rb: 'text/x-ruby; charset=utf-8',
  php: 'application/x-httpd-php; charset=utf-8',
  swift: 'text/x-swift; charset=utf-8',
  kt: 'text/x-kotlin; charset=utf-8',
  kts: 'text/x-kotlin; charset=utf-8',
  java: 'text/x-java-source; charset=utf-8',
  c: 'text/x-c; charset=utf-8',
  h: 'text/x-c; charset=utf-8',
  cpp: 'text/x-c++; charset=utf-8',
  cc: 'text/x-c++; charset=utf-8',
  cxx: 'text/x-c++; charset=utf-8',
  hpp: 'text/x-c++; charset=utf-8',
  cs: 'text/x-csharp; charset=utf-8',
  lua: 'text/x-lua; charset=utf-8',
  r: 'text/x-r; charset=utf-8',
  scala: 'text/x-scala; charset=utf-8',
  dart: 'text/x-dart; charset=utf-8',
  vue: 'text/x-vue; charset=utf-8',
  svelte: 'text/x-svelte; charset=utf-8',
  epub: 'application/epub+zip',
};

function normalizeExt(path: string): string {
  return extname(path).replace(/^\./, '').toLowerCase();
}

export function classifyFileArtifactKind(ext: string): FileArtifactKind | null {
  const normalized = ext.toLowerCase();
  if (DECK_EXTENSIONS.has(normalized)) return 'deck';
  if (DOCUMENT_EXTENSIONS.has(normalized)) return 'document';
  if (SHEET_EXTENSIONS.has(normalized)) return 'sheet';
  if (IMAGE_EXTENSIONS.has(normalized)) return 'image';
  if (ARCHIVE_EXTENSIONS.has(normalized)) return 'archive';
  if (CODE_EXTENSIONS.has(normalized)) return 'code';
  if (OTHER_DELIVERABLE_EXTENSIONS.has(normalized)) return 'other';
  return normalized ? 'other' : null;
}

export function mimeForFileExtension(ext: string): string {
  return MIME_BY_EXT[ext.toLowerCase()] ?? 'application/octet-stream';
}

export function mimeForFilePath(path: string): string {
  return mimeForFileExtension(normalizeExt(path));
}

function fingerprint(candidate: CandidateFile): FileFingerprint {
  return {
    size: candidate.data.size,
    mtimeMs: candidate.mtimeMs,
    ctimeMs: candidate.ctimeMs,
  };
}

/**
 * Resolve a path the way the scanner keys it. Exported so producers that hand
 * the scanner a path to skip (`turnRichArtifactPaths`) key it identically — a
 * plain `resolve()` misses when any parent is a symlink, and the skip silently
 * stops working.
 */
export async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

function sameFingerprint(a: FileFingerprint | undefined, b: FileFingerprint): boolean {
  if (!a) return false;
  return a.size === b.size
    && a.mtimeMs === b.mtimeMs
    && a.ctimeMs === b.ctimeMs;
}

async function contentHash(candidate: CandidateFile): Promise<string | null> {
  try {
    const hash = createHash('sha256');
    await new Promise<void>((resolveHash, rejectHash) => {
      const stream = createReadStream(candidate.data.path);
      stream.on('data', chunk => hash.update(chunk));
      stream.on('error', rejectHash);
      stream.on('end', resolveHash);
    });
    return hash.digest('hex');
  } catch {
    return null;
  }
}

function contentKey(candidate: CandidateFile, hash: string | null): string | null {
  return hash ? `${candidate.data.ext}:${candidate.data.size}:${hash}` : null;
}

function filenameQuality(filename: string): number {
  const meaningful = filename.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
  const placeholders = filename.match(/_+/g)?.reduce((total, run) => total + run.length, 0) ?? 0;
  return meaningful - placeholders;
}

function preferCandidate(next: CandidateFile, current: CandidateFile): boolean {
  const nextChangedAt = Math.max(next.mtimeMs, next.ctimeMs);
  const currentChangedAt = Math.max(current.mtimeMs, current.ctimeMs);
  if (nextChangedAt !== currentChangedAt) return nextChangedAt > currentChangedAt;
  return filenameQuality(next.data.filename) > filenameQuality(current.data.filename);
}

function shouldSkipPathSegment(segment: string): boolean {
  if (!segment) return true;
  if (segment.startsWith('.')) return true;
  return SKIPPED_DIRECTORY_NAMES.has(segment.toLowerCase());
}

function shouldSkipFileName(filename: string): boolean {
  const lower = filename.toLowerCase();
  return filename.startsWith('.')
    || lower === 'tmp'
    || lower === 'temp'
    || lower.endsWith('.tmp')
    || lower.endsWith('.temp')
    || lower.endsWith('~')
    || lower.startsWith('~$')
    || lower.includes('.tmp.');
}

function isPathUnderRoot(targetPath: string, rootPath: string): boolean {
  return isPathInsideRoot(resolve(targetPath), resolve(rootPath));
}

function canonicalExistingPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function dedupeScanRoots(roots: ScanRoot[]): ScanRoot[] {
  const out: ScanRoot[] = [];
  for (const root of roots) {
    const canonical = canonicalExistingPath(root.path);
    if (out.some((existing) => existing.path === canonical)) continue;
    out.push({ ...root, path: canonical });
  }
  return out;
}

export function resolveScanRoots(activeRootPath?: string, userId?: string): ScanRoot[] {
  // The API serves files out of exactly these roots — `allowedFsRootsForUser`
  // calls this same function. Carding a file outside them yields a card whose
  // preview 404s, which is worse than no card: the card asserts the deliverable
  // is there and then cannot produce it. Filtering every root through this makes
  // "scanned ⊆ servable" hold by construction, instead of depending on three
  // separately-derived lists happening to agree.
  const servableRoots = getWorkspaceAllowedRoots(userId).map(canonicalExistingPath);
  const isServable = (path: string): boolean =>
    servableRoots.some((root) => isPathUnderRoot(path, root));

  const candidates: ScanRoot[] = [];
  // Put the active project first so an exact overlap with the workspace keeps
  // project semantics for explicit code deliverables.
  if (activeRootPath?.trim()) {
    candidates.push({ path: canonicalExistingPath(activeRootPath.trim()), kind: 'project' });
  }
  candidates.push(
    { path: resolve(getOutputDir()), kind: 'output' },
    // Shell's cwd is the workspace, so a script writing a relative path puts the
    // deliverable here, not in `output`. Scanning only `output` meant a finished
    // report could exist with no card at all while its own research notes had
    // one — the file was real, MOZI just never looked where it told the shell to
    // work. `emitPaths` already treats the workspace as in scope; only the
    // recursive scan disagreed.
    { path: resolve(getWorkspaceDir(userId)), kind: 'workspace' },
  );

  return dedupeScanRoots(candidates.filter((root) => isServable(canonicalExistingPath(root.path))));
}

function candidateFromStat(
  root: ScanRoot,
  filePath: string,
  size: number,
  mtimeMs: number,
  ctimeMs: number,
  explicit = false,
): CandidateFile | null {
  const filename = basename(filePath);
  if (shouldSkipFileName(filename)) return null;

  const relativePath = relative(root.path, filePath);
  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  if (segments.some(shouldSkipPathSegment)) return null;

  // MOZI's own bookkeeping lives in the workspace next to the user's files.
  // `tasks/` alone is written on ordinary turns, so scanning it would card the
  // runtime's own state as deliverables. `artifacts/` holds files a rich card
  // already owns.
  if (root.kind === 'workspace' && segments.length > 1
      && WORKSPACE_INTERNAL_DIRS.has(segments[0].toLowerCase())) {
    return null;
  }

  const ext = normalizeExt(filePath);
  const kind = classifyFileArtifactKind(ext);
  if (!kind) return null;
  if (!explicit && (kind === 'code' || kind === 'other')) return null;
  // Scripts in a MOZI-owned root are how a deliverable got made, not the
  // deliverable. In a user's own project they may be the point, so this is
  // keyed on the root, not the extension alone.
  if ((root.kind === 'output' || root.kind === 'workspace') && ext === 'py') return null;

  const resolvedPath = resolve(filePath);
  return {
    data: {
      path: resolvedPath,
      filename,
      ext,
      size,
      mime: mimeForFileExtension(ext),
      kind,
      downloadUrl: `/api/fs/file?${new URLSearchParams({ path: resolvedPath }).toString()}`,
      ...buildFileArtifactPreviewFields(resolvedPath, ext),
      // Explicit boolean — merge-over-store semantics make an absent key
      // unable to clear a previously persisted `missing: true`.
      missing: false,
    },
    mtimeMs,
    ctimeMs,
    rootKind: root.kind,
  };
}

async function collectDeliverableFiles(root: ScanRoot): Promise<CandidateFile[]> {
  const candidates: CandidateFile[] = [];

  async function walk(dirPath: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const entryPath = resolve(dirPath, entry.name);
      const relativePath = relative(root.path, entryPath);
      const segments = relativePath.split(/[\\/]+/).filter(Boolean);
      if (segments.some(shouldSkipPathSegment)) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;

      let stats;
      try {
        stats = await lstat(entryPath);
      } catch {
        continue;
      }
      if (!stats.isFile()) continue;

      const candidate = candidateFromStat(root, entryPath, stats.size, stats.mtimeMs, stats.ctimeMs);
      if (candidate) candidates.push(candidate);
    }
  }

  await walk(root.path);
  return candidates;
}

function buildFileArtifactPatch(artifactId: string, data: FileArtifactData): Parameters<ArtifactCoordinator['patchArtifact']>[1] {
  return {
    plugin_id: 'file_v1',
    title: data.filename,
    status: 'completed',
    fallback_text: `File ready: ${data.filename}`,
    data: { ...data },
    updated_at: new Date().toISOString(),
  };
}

/**
 * Extensions that represent a produced document a user asks for by name.
 *
 * Keyed on extension rather than `kind` because `kind` is too coarse here:
 * `DOCUMENT_EXTENSIONS` includes `md`/`txt`, so a scratch `summary.md` or
 * `notes.txt` dropped beside the real output would count as a deliverable and
 * demote everything else — collapsing the five charts a user actually asked for
 * behind a throwaway note. A rendered/binary document format is a much better
 * signal of "this is the artifact", and `csv` is likewise excluded because it is
 * as often intermediate data as a deliverable.
 */
const PRIMARY_DOC_EXTENSIONS = new Set(['pptx', 'key', 'docx', 'pdf', 'rtf', 'xlsx', 'epub']);

function isPrimaryDeliverable(data: FileArtifactData): boolean {
  return PRIMARY_DOC_EXTENSIONS.has(data.ext.toLowerCase());
}

/**
 * Whether a file may claim the `primary` slot given what else the turn made.
 *
 * Extension alone is the wrong test once the turn has authored a rich
 * renderable deliverable (sandpack page / Brain document): a plan that
 * downloads `Online_Retail.xlsx` as source data and authors an HTML report
 * would hero-card the raw dataset on its `.xlsx` extension (real incident,
 * 2026-07-18). With a rich deliverable present, only deck/document files —
 * things a user plausibly asked for as THE deliverable (PDF/PPTX/DOCX) — keep
 * primary eligibility; data sheets, archives, images become supporting.
 */
function eligibleAsPrimary(data: FileArtifactData, richArtifactDeliverable: boolean): boolean {
  if (!isPrimaryDeliverable(data)) return false;
  if (!richArtifactDeliverable) return true;
  return data.kind === 'deck' || data.kind === 'document';
}
/** Display priority when a batch mixes deliverable kinds (lower = shown first). */
const DELIVERABLE_KIND_RANK: Record<string, number> = {
  deck: 0, document: 1, sheet: 2, archive: 3, image: 4, code: 5, other: 6,
};

/**
 * Decide which produced files lead and which are working material.
 *
 * A report/deck task drops its final `.pdf`/`.pptx` next to the material it
 * built along the way: per-slide render frames, generated charts, the script
 * that produced them. The user asked for the report, so the report leads and
 * everything else co-produced in the same turn is `supporting` — collapsed in
 * the timeline behind the deliverable, but durable and one click away.
 *
 * The rule is deliberately independent of filenames. This previously keyed off
 * a regex of anticipated frame names (`slide-01.jpg`, `page_3.png`), which asks
 * "is this named like a frame I expected?" rather than "is this the thing the
 * user asked for?". It therefore missed anything named differently — five
 * `chart1_yield_curve.png`-style charts were published as sibling cards beside
 * the PDF they were embedded in — and would have kept missing the next naming
 * scheme. Any name-pattern list is a guess about model behaviour; whether the
 * turn produced a deliverable is a fact about the turn.
 *
 * Note this marks rather than filters: the old regex path *dropped* matched
 * frames outright, so material the user might legitimately want disappeared
 * with no way to reach it. Nothing is dropped now.
 *
 * When a turn produces no primary document (e.g. charts were the actual
 * request), nothing is demoted and every file leads as before.
 *
 * `turnHasPrimaryDoc` carries the decision across scans. Files are scanned after
 * each tool batch, so a turn that renders its charts in one step and assembles
 * the report in the next would otherwise publish the charts as deliverables
 * before any deliverable existed. The caller latches this for the whole turn and
 * demotes anything already emitted (see `demoteEmittedToSupporting`).
 */
export function curateDeliverables(
  candidates: CandidateFile[],
  turnHasPrimaryDoc = false,
  richArtifactDeliverable = false,
): CandidateFile[] {
  const hasDeliverable = turnHasPrimaryDoc || richArtifactDeliverable
    || candidates.some((c) => eligibleAsPrimary(c.data, richArtifactDeliverable));
  const roled = hasDeliverable
    ? candidates.map((c) => (
      eligibleAsPrimary(c.data, richArtifactDeliverable)
        ? { ...c, data: { ...c.data, role: 'primary' as const } }
        : { ...c, data: { ...c.data, role: 'supporting' as const } }
    ))
    : candidates;
  return [...roled].sort((a, b) => {
    const ra = DELIVERABLE_KIND_RANK[a.data.kind] ?? 9;
    const rb = DELIVERABLE_KIND_RANK[b.data.kind] ?? 9;
    return ra !== rb ? ra - rb : a.data.path.localeCompare(b.data.path);
  });
}

export function createTurnFileArtifactTracker(options: TurnFileArtifactTrackerOptions): TurnFileArtifactTracker {
  const roots = resolveScanRoots(options.activeRootPath, options.userId);
  const servableRoots = [...new Set(getWorkspaceAllowedRoots(options.userId).map(canonicalExistingPath))];
  const turnStartedAtMs = Date.now();
  const baseline = new Map<string, FileFingerprint>();
  const emitted = new Map<string, EmittedFile>();
  const emittedByContent = new Map<string, ContentArtifact>();
  let lastSkillName: string | undefined;
  /** Latched for the turn: files are scanned per tool batch, the decision is per turn. */
  let turnHasPrimaryDoc = false;
  /** Latched: the turn authored a rich renderable (sandpack/document) — see `eligibleAsPrimary`. */
  let turnHasRichDeliverable = false;

  async function collectAll(): Promise<CandidateFile[]> {
    const nestedRoots = roots.filter((root, index) => (
      roots.some((other, otherIndex) => otherIndex !== index && isPathUnderRoot(root.path, other.path))
    ));
    const candidates: CandidateFile[] = [];
    for (const root of roots) {
      if (nestedRoots.includes(root)) continue;
      candidates.push(...await collectDeliverableFiles(root));
    }
    return candidates;
  }

  async function scanAndEmit(): Promise<void> {
    if (!options.artifactCoordinator) return;

    let candidates: CandidateFile[];
    try {
      candidates = await collectAll();
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to scan file artifacts');
      return;
    }

    await emitCandidates(candidates, false);
    sweepMissingEmitted();
  }

  /**
   * Deliverable-shelf liveness sweep (operator decision 2026-07-19, extends
   * the #781 "disk is the render truth" doctrine to file cards): any card
   * this turn emitted whose file has since vanished — whatever deleted it,
   * shell, skill script, or the user in Finder — is patched `missing: true`
   * through the same persist-then-broadcast path, so the UI can say so
   * instead of 404ing on open. A file that REAPPEARS (regenerated at the
   * same path) clears the flag the same way.
   */
  function sweepMissingEmitted(): void {
    const coordinator = options.artifactCoordinator;
    if (!coordinator) return;
    for (const [key, record] of emitted) {
      let exists = false;
      try {
        exists = statSync(key).isFile();
      } catch {
        exists = false;
      }
      const wasMissing = record.data.missing === true;
      if (exists === !wasMissing) continue;
      // Explicit boolean, never key deletion — store and client MERGE patches.
      record.data = { ...record.data, missing: !exists };
      coordinator.patchArtifact(record.artifactId, buildFileArtifactPatch(record.artifactId, record.data));
      logger.warn(
        { path: key, artifactId: record.artifactId, missing: !exists },
        !exists
          ? 'Carded deliverable vanished from disk — card marked missing'
          : 'Missing deliverable reappeared on disk — card restored',
      );
    }
  }

  /**
   * Demote files already published this turn now that a deliverable exists.
   *
   * Without this, a turn that renders charts in one tool batch and assembles the
   * report in the next leaves the charts permanently presented as deliverables:
   * their batch was scanned before the report existed, so nothing outranked them
   * at the time.
   */
  function demoteEmittedToSupporting(coordinator: ArtifactCoordinator): void {
    const patched = new Set<string>();
    for (const record of emitted.values()) {
      if (patched.has(record.artifactId)) continue;
      // Eligibility is re-evaluated under the CURRENT latches: a data sheet
      // emitted `primary` before the turn authored its rich deliverable loses
      // eligibility when that deliverable appears, and must be demoted too.
      if (eligibleAsPrimary(record.data, turnHasRichDeliverable) || record.data.role === 'supporting') continue;
      patched.add(record.artifactId);
      record.data = { ...record.data, role: 'supporting' };
      coordinator.patchArtifact(record.artifactId, buildFileArtifactPatch(record.artifactId, record.data));
    }
  }

  async function emitCandidates(candidates: CandidateFile[], explicit: boolean): Promise<void> {
    const coordinator = options.artifactCoordinator;
    if (!coordinator) return;
    // A Brain-authored `document_v1` (report/deck body) never passes through
    // this filesystem scan, but it IS the turn's primary deliverable — files
    // co-produced beside it are supporting material (Issue #735). The
    // coordinator sees both artifact paths, so ask it too.
    // Latch the rich-deliverable signal FIRST so this batch's eligibility (and
    // the demotion sweep below) already sees it — the sweep re-demotes files an
    // earlier batch published as `primary` on extension alone.
    if (!turnHasRichDeliverable && coordinator.hasCompletedRenderableArtifact()) {
      turnHasRichDeliverable = true;
      demoteEmittedToSupporting(coordinator);
    }
    // Minting is opt-in, not opt-out (operator decision 2026-07-19; real
    // incident: a dataset-analysis turn carded 74 artifacts — the downloaded
    // zip, the extracted 540k-row xlsx, every intermediate png — and the chat
    // showed "68 supporting files" under the report. Blocklists lose: the tail
    // of machine-written files is unbounded, the rules are not).
    //
    //   - `output/` is the deliverable shelf (#792 defends it against
    //     deletion): everything recognized there minted a card before and
    //     still does — putting a file on the shelf IS the declaration.
    //   - `workspace`/`project` scans mint only primary-eligible documents
    //     (PDF/PPTX/DOCX/XLSX…). This keeps the one real counter-incident —
    //     a finished report written to the shell's cwd instead of `output/`
    //     had no card at all — without carding the working material around it.
    //   - Explicit `emitPaths` reports are declarations and skip the gate.
    //
    // A file this turn ALREADY minted stays visible to the loop so its
    // fingerprint updates and demotions keep flowing.
    const mintable = explicit
      ? candidates
      : candidates.filter((c) => c.rootKind === 'output'
        || eligibleAsPrimary(c.data, turnHasRichDeliverable)
        || emitted.has(c.data.path));
    const batchHasPrimaryDoc = mintable.some((c) => eligibleAsPrimary(c.data, turnHasRichDeliverable))
      || coordinator.hasPrimaryDocument();
    if (batchHasPrimaryDoc && !turnHasPrimaryDoc) {
      turnHasPrimaryDoc = true;
      demoteEmittedToSupporting(coordinator);
    }
    for (const candidate of curateDeliverables(mintable, turnHasPrimaryDoc, turnHasRichDeliverable)) {
      const key = await canonicalPath(candidate.data.path);
      // Re-check the canonical file, not only the configured root. This keeps a
      // root symlink or a path changed during a scan from producing a card the
      // file API cannot serve.
      if (!servableRoots.some((root) => isPathUnderRoot(key, root))) continue;
      const nextFingerprint = fingerprint(candidate);
      if (sameFingerprint(baseline.get(key), nextFingerprint)) continue;
      if (options.richArtifactPaths?.has(key)) continue;
      if (!explicit && candidate.mtimeMs < turnStartedAtMs && candidate.ctimeMs < turnStartedAtMs && !emitted.has(key)) continue;
      let candidateHash: string | null | undefined;
      const getCandidateHash = async (): Promise<string | null> => {
        if (candidateHash === undefined) candidateHash = await contentHash(candidate);
        return candidateHash;
      };
      const canonicalData: FileArtifactData = candidate.data.path === key
        ? candidate.data
        : {
            ...candidate.data,
            path: key,
            downloadUrl: `/api/fs/file?${new URLSearchParams({ path: key }).toString()}`,
            ...buildFileArtifactPreviewFields(key, candidate.data.ext),
          };
      const data: FileArtifactData = lastSkillName
        ? { ...canonicalData, skillName: lastSkillName }
        : canonicalData;

      if (options.tenantId) {
        const currentMtimeMs = Math.trunc(candidate.mtimeMs);
        const registered = deliverableRegistry.getByPath(options.tenantId, key);
        const changed = !registered
          || registered.currentSize !== candidate.data.size
          || registered.currentMtimeMs !== currentMtimeMs;
        candidateHash = changed ? await getCandidateHash() : registered.currentHash;
        const deliverable = deliverableRegistry.upsertByPath({
          tenantId: options.tenantId,
          path: key,
          kind: candidate.data.kind,
          title: candidate.data.filename,
          currentSize: candidate.data.size,
          currentMtimeMs,
          currentHash: candidateHash,
          sessionId: options.sessionId,
          initialVersionCount: 0,
        });
        if (changed) {
          const version = registered ? registered.versionCount + 1 : 1;
          try {
            deliverableVersionStore.snapshot({
              tenantId: options.tenantId,
              deliverableId: deliverable.id,
              version,
              sourcePath: key,
              hash: candidateHash ?? null,
              sessionId: options.sessionId,
            });
          } catch (error) {
            logger.warn({
              err: error,
              deliverableId: deliverable.id,
              path: key,
              version,
            }, 'Deliverable snapshot failed; continuing artifact minting');
          }
        }
      }

      const previous = emitted.get(key);
      // Identity lives in this turn's memory, so a path an *earlier* turn of the
      // session published looks brand new here — a plan's background turn
      // generates and publishes the deliverable, then this turn's scan finds the
      // same file on the shared output dir and publishes it again.
      //
      // Adopt that artifact rather than skipping the file. Skipping cannot tell
      // the plan-handoff duplicate from a later turn legitimately regenerating
      // the same path — both are "not mine, already on the timeline" — and would
      // leave the regenerating turn showing nothing at all. Adopting patches the
      // existing card in both cases, which is the single-card outcome either way.
      if (!previous && !coordinator.resolveByPath(key)) {
        const publishedId = options.resolvePublishedArtifactId?.(key);
        if (publishedId) {
          coordinator.adoptFileByPath(publishedId, key, {
            plugin_id: 'file_v1',
            title: data.filename,
            status: 'completed',
            fallback_text: `File ready: ${data.filename}`,
            data: { ...data },
          });
        }
      }
      const resolvedArtifactId = coordinator.resolveByPath(key);
      if (resolvedArtifactId) {
        if (previous && sameFingerprint(previous.fingerprint, nextFingerprint)) continue;
        const nextContentKey = contentKey(candidate, await getCandidateHash());
        const record: EmittedFile = {
          artifactId: resolvedArtifactId,
          fingerprint: nextFingerprint,
          contentKey: nextContentKey ?? `path:${key}`,
          data,
        };
        emitted.set(key, record);
        if (nextContentKey && !emittedByContent.has(nextContentKey)) {
          emittedByContent.set(nextContentKey, { artifactId: resolvedArtifactId, candidate });
        }
        coordinator.patchArtifact(resolvedArtifactId, buildFileArtifactPatch(resolvedArtifactId, data));
        continue;
      }

      if (!previous) {
        const nextContentKey = contentKey(candidate, await getCandidateHash());
        const duplicate = nextContentKey ? emittedByContent.get(nextContentKey) : undefined;
        if (duplicate) {
          coordinator.bindPathToArtifact(duplicate.artifactId, key);
          emitted.set(key, {
            artifactId: duplicate.artifactId,
            fingerprint: nextFingerprint,
            contentKey: nextContentKey!,
            data,
          });
          if (preferCandidate(candidate, duplicate.candidate)) {
            duplicate.candidate = candidate;
            coordinator.patchArtifact(
              duplicate.artifactId,
              buildFileArtifactPatch(duplicate.artifactId, data),
            );
          }
          continue;
        }
        const artifactId = coordinator.openFileByPath(key, {
          plugin_id: 'file_v1',
          title: data.filename,
          status: 'completed',
          collapsed_by_default: false,
          fallback_text: `File ready: ${data.filename}`,
          data: { ...data },
        });
        const record: EmittedFile = {
          artifactId,
          fingerprint: nextFingerprint,
          contentKey: nextContentKey ?? `path:${key}`,
          data,
        };
        emitted.set(key, record);
        if (nextContentKey) emittedByContent.set(nextContentKey, { artifactId, candidate });
        continue;
      }

      if (sameFingerprint(previous.fingerprint, nextFingerprint)) continue;
      if (emittedByContent.get(previous.contentKey)?.artifactId === previous.artifactId) {
        emittedByContent.delete(previous.contentKey);
      }
      const nextContentKey = contentKey(candidate, await getCandidateHash());
      previous.fingerprint = nextFingerprint;
      previous.contentKey = nextContentKey ?? `path:${key}`;
      // Keep the record's data current with what was just patched: a later
      // demotion re-patches from this record, and stale data would revert the
      // artifact's size/preview fields to the first emit's values.
      previous.data = data;
      emitted.set(key, previous);
      if (nextContentKey) emittedByContent.set(nextContentKey, { artifactId: previous.artifactId, candidate });
      coordinator.patchArtifact(previous.artifactId, buildFileArtifactPatch(previous.artifactId, data));
    }
  }

  async function emitPaths(paths: readonly string[]): Promise<void> {
    const configuredRoots = dedupeScanRoots([
      ...roots,
      ...getWorkspaceAllowedRoots(options.userId).map(path => ({ path, kind: 'project' as const })),
    ]);
    const allowedRoots = (await Promise.all(configuredRoots.map(async root => ({
      ...root,
      path: await canonicalPath(root.path),
    })))).sort((a, b) => b.path.length - a.path.length);
    const candidates: CandidateFile[] = [];
    for (const rawPath of new Set(paths.map(path => path.trim()).filter(Boolean))) {
      const filePath = await canonicalPath(rawPath);
      const root = allowedRoots.find(candidate => isPathUnderRoot(filePath, candidate.path));
      if (!root) continue;
      try {
        const stats = await lstat(filePath);
        if (!stats.isFile()) continue;
        const candidate = candidateFromStat(root, filePath, stats.size, stats.mtimeMs, stats.ctimeMs, true);
        if (candidate) candidates.push(candidate);
      } catch {
        // A worker may report a path that was cleaned up before delivery.
      }
    }
    await emitCandidates(candidates, true);
  }

  return {
    async captureBaseline(): Promise<void> {
      const candidates = await collectAll();
      baseline.clear();
      for (const candidate of candidates) {
        baseline.set(await canonicalPath(candidate.data.path), fingerprint(candidate));
      }
    },

    noteSkillUse(skillName: string): void {
      const trimmed = skillName.trim();
      if (trimmed) lastSkillName = trimmed;
    },

    scanAndEmit,
    emitPaths,
  };
}
