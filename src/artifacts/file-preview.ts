import { createHash, randomUUID } from 'node:crypto';
import { accessSync, constants as fsConstants, readFileSync, type Stats } from 'node:fs';
import { access, mkdir, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { delimiter, extname, isAbsolute, join, resolve } from 'node:path';
import pino from 'pino';
import { execFile } from '../capabilities/shell.js';
import { getMoziHome } from '../paths.js';
import { getWorkspaceAllowedRoots, isPathInsideRoot } from '../tools/workspace-policy.js';

const logger = pino({ name: 'mozi:file-preview' });

const QUICKLOOK_COMMAND = '/usr/bin/qlmanage';
const PREVIEW_TIMEOUT_MS = 10_000;
const SOFFICE_PREVIEW_MESSAGE = 'Document preview requires LibreOffice (soffice). Install it or run the Docker image.';
const CSV_TSV_PREVIEW_ROWS = 50;

export const DEFAULT_FILE_PREVIEW_WIDTH = 1024;
export const MIN_FILE_PREVIEW_WIDTH = 64;
export const MAX_FILE_PREVIEW_WIDTH = 4096;

const QUICKLOOK_PREVIEW_EXTENSIONS = new Set([
  'pptx',
  'key',
  'pages',
  'numbers',
  'docx',
  'xlsx',
  'pdf',
]);

const SOFFICE_PREVIEW_EXTENSIONS = new Set([
  'docx',
  'pptx',
  'xlsx',
  'pdf',
]);

const PDF_PREVIEW_EXTENSIONS = new Set([
  'pdf',
]);

const TABLE_PREVIEW_EXTENSIONS = new Set([
  'csv',
  'tsv',
]);

const DIRECT_IMAGE_PREVIEW_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
]);

export type FilePreviewKind = 'image' | 'document-pages' | 'table' | 'download-card';

export interface FilePreviewTablePayload {
  rows: string[][];
  truncated: boolean;
}

export interface FileArtifactPreviewFields {
  previewable: boolean;
  previewUrl?: string;
  previewKind?: FilePreviewKind;
  previewRows?: string[][];
  previewRowsTruncated?: boolean;
  previewMessage?: string;
}

export interface FilePreviewOptions {
  width: number;
  timeoutMs?: number;
  cacheDir?: string;
  platform?: NodeJS.Platform;
}

interface AllowedPreviewFile {
  path: string;
  stats: Stats;
}

export interface FilePreviewPage {
  pageNumber: number;
  path: string;
}

export interface FilePreviewPngSequence {
  pages: FilePreviewPage[];
  source: 'cache' | 'quicklook' | 'soffice' | 'pdftoppm' | 'imagemagick';
}

function normalizePreviewExt(value: string): string {
  const ext = extname(value);
  return (ext || value).replace(/^\./, '').toLowerCase();
}

function previewQuery(path: string): string {
  return new URLSearchParams({ path }).toString();
}

export function canRunQuickLookPreviews(platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'darwin' && isExecutableSync(QUICKLOOK_COMMAND)) return true;
  return detectSofficeSync() !== null || detectPdfPreviewBinarySync() !== null;
}

export function isQuickLookPreviewExtension(pathOrExt: string): boolean {
  return QUICKLOOK_PREVIEW_EXTENSIONS.has(normalizePreviewExt(pathOrExt));
}

export function isDirectImagePreviewExtension(pathOrExt: string): boolean {
  return DIRECT_IMAGE_PREVIEW_EXTENSIONS.has(normalizePreviewExt(pathOrExt));
}

function executableCandidates(binary: string, extras: string[] = []): string[] {
  const pathCandidates = (process.env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, binary));
  return [...pathCandidates, ...extras];
}

function isExecutableSync(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function detectExecutableSync(binary: string, extras: string[] = []): string | null {
  for (const candidate of executableCandidates(binary, extras)) {
    if (isExecutableSync(candidate)) return candidate;
  }
  return null;
}

async function detectExecutable(binary: string, extras: string[] = []): Promise<string | null> {
  for (const candidate of executableCandidates(binary, extras)) {
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

function sofficeCandidates(): string[] {
  return [
    '/opt/homebrew/bin/soffice',
    '/usr/local/bin/soffice',
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    '/usr/bin/soffice',
  ];
}

function detectSofficeSync(): string | null {
  return detectExecutableSync('soffice', sofficeCandidates());
}

export async function detectSoffice(): Promise<string | null> {
  return detectExecutable('soffice', sofficeCandidates());
}

function detectPdfPreviewBinarySync(): string | null {
  return detectExecutableSync('pdftoppm') ?? detectExecutableSync('convert');
}

function canPreviewDocumentExt(ext: string, platform: NodeJS.Platform): boolean {
  const normalized = normalizePreviewExt(ext);
  if (platform === 'darwin' && QUICKLOOK_PREVIEW_EXTENSIONS.has(normalized) && isExecutableSync(QUICKLOOK_COMMAND)) return true;
  if (SOFFICE_PREVIEW_EXTENSIONS.has(normalized) && detectSofficeSync()) return true;
  return PDF_PREVIEW_EXTENSIONS.has(normalized) && detectPdfPreviewBinarySync() !== null;
}

function parseDelimitedRows(content: string, delimiterChar: ',' | '\t', maxRows: number): FilePreviewTablePayload {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let truncated = false;

  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    const next = content[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && char === delimiterChar) {
      row.push(cell);
      cell = '';
      continue;
    }

    if (!inQuotes && (char === '\n' || char === '\r')) {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      if (char === '\r' && next === '\n') i += 1;
      if (rows.length >= maxRows) {
        truncated = i < content.length - 1;
        break;
      }
      continue;
    }

    cell += char;
  }

  if (rows.length < maxRows && (cell.length > 0 || row.length > 0)) {
    row.push(cell);
    rows.push(row);
  }

  return { rows, truncated };
}

function readDelimitedPreviewRows(path: string, ext: string): FilePreviewTablePayload | null {
  try {
    const content = readFileSync(path, 'utf8');
    return parseDelimitedRows(content, ext === 'tsv' ? '\t' : ',', CSV_TSV_PREVIEW_ROWS);
  } catch (err) {
    logger.warn({
      path,
      err: err instanceof Error ? err.message : String(err),
    }, 'CSV/TSV preview rows could not be read');
    return null;
  }
}

export function buildFileArtifactPreviewFields(
  filePath: string,
  ext: string,
  platform: NodeJS.Platform = process.platform,
): FileArtifactPreviewFields {
  if (isDirectImagePreviewExtension(ext)) {
    return {
      previewable: true,
      previewKind: 'image',
      previewUrl: `/api/fs/file?${previewQuery(filePath)}`,
    };
  }

  if (TABLE_PREVIEW_EXTENSIONS.has(normalizePreviewExt(ext))) {
    const preview = readDelimitedPreviewRows(filePath, normalizePreviewExt(ext));
    return {
      previewable: preview !== null,
      previewKind: preview ? 'table' : 'download-card',
      ...(preview ? {
        previewRows: preview.rows,
        previewRowsTruncated: preview.truncated,
      } : {
        previewMessage: 'Tabular preview is unavailable. Download the file to open it locally.',
      }),
    };
  }

  if (isQuickLookPreviewExtension(ext) && canPreviewDocumentExt(ext, platform)) {
    return {
      previewable: true,
      previewKind: 'document-pages',
      previewUrl: `/api/fs/preview?${previewQuery(filePath)}`,
    };
  }

  if (SOFFICE_PREVIEW_EXTENSIONS.has(normalizePreviewExt(ext))) {
    return {
      previewable: false,
      previewKind: 'download-card',
      previewMessage: SOFFICE_PREVIEW_MESSAGE,
    };
  }

  return { previewable: false };
}

export function getFilePreviewCacheDir(): string {
  return join(getMoziHome(), 'cache', 'previews');
}

function normalizeWidth(width: number): number | null {
  if (!Number.isFinite(width)) return null;
  const rounded = Math.round(width);
  if (rounded < MIN_FILE_PREVIEW_WIDTH || rounded > MAX_FILE_PREVIEW_WIDTH) return null;
  return rounded;
}

async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

async function resolveAllowedPreviewFile(inputPath: string): Promise<AllowedPreviewFile | null> {
  const trimmed = inputPath.trim();
  if (!trimmed || !isAbsolute(trimmed)) return null;

  const realTarget = await realpathOrNull(resolve(trimmed));
  if (!realTarget) return null;

  let stats: Stats;
  try {
    stats = await stat(realTarget);
  } catch {
    return null;
  }
  if (!stats.isFile()) return null;

  for (const root of getWorkspaceAllowedRoots()) {
    const realRoot = await realpathOrNull(root);
    if (realRoot && isPathInsideRoot(realTarget, realRoot)) {
      return { path: realTarget, stats };
    }
  }

  return null;
}

function cacheKey(filePath: string, mtimeMs: number, width: number): string {
  return createHash('sha256')
    .update(filePath)
    .update('\0')
    .update(String(mtimeMs))
    .update('\0')
    .update(String(width))
    .digest('hex');
}

async function findGeneratedPngs(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  const matches: string[] = [];
  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      matches.push(...await findGeneratedPngs(entryPath));
      continue;
    }
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.png')) continue;
    const pngStats = await stat(entryPath);
    if (pngStats.size > 0) matches.push(entryPath);
  }

  return matches.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

async function findGeneratedFile(dir: string, ext: string): Promise<string | null> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await findGeneratedFile(entryPath, ext);
      if (nested) return nested;
      continue;
    }
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(`.${ext}`)) continue;
    const generatedStats = await stat(entryPath);
    if (generatedStats.size > 0) return entryPath;
  }

  return null;
}

async function readCachedPreviewPages(dir: string): Promise<FilePreviewPage[] | null> {
  const pngs = await findGeneratedPngs(dir);
  if (pngs.length === 0) return null;
  return pngs.map((path, index) => ({ pageNumber: index + 1, path }));
}

async function storePreviewPages(generatedPngs: string[], cachePagesDir: string): Promise<FilePreviewPage[]> {
  await rm(cachePagesDir, { recursive: true, force: true }).catch(() => undefined);
  await mkdir(cachePagesDir, { recursive: true, mode: 0o700 });

  const pages: FilePreviewPage[] = [];
  for (const [index, generatedPng] of generatedPngs.entries()) {
    const pageNumber = index + 1;
    const target = join(cachePagesDir, `page-${String(pageNumber).padStart(4, '0')}.png`);
    await rename(generatedPng, target);
    pages.push({ pageNumber, path: target });
  }
  return pages;
}

async function runQuickLookPreview(inputPath: string, tempDir: string, width: number, timeoutMs: number): Promise<string[] | null> {
  const result = await execFile(QUICKLOOK_COMMAND, [
    '-t',
    '-s',
    String(width),
    '-o',
    tempDir,
    inputPath,
  ], {
    cwd: tempDir,
    timeout: timeoutMs,
  });

  if (result.exit_code !== 0 || result.timed_out) {
    logger.warn({
      path: inputPath,
      width,
      exitCode: result.exit_code,
      timedOut: result.timed_out,
      stderr: result.stderr.slice(0, 500),
    }, 'QuickLook preview generation failed');
    return null;
  }

  return findGeneratedPngs(tempDir);
}

async function runSofficeConvert(soffice: string, inputPath: string, outdir: string, format: 'pdf' | 'png', timeoutMs: number): Promise<boolean> {
  const result = await execFile(soffice, [
    '--headless',
    '--convert-to',
    format,
    '--outdir',
    outdir,
    inputPath,
  ], {
    cwd: outdir,
    timeout: timeoutMs,
  });

  if (result.exit_code !== 0 || result.timed_out) {
    logger.warn({
      path: inputPath,
      format,
      exitCode: result.exit_code,
      timedOut: result.timed_out,
      stderr: result.stderr.slice(0, 500),
    }, 'LibreOffice preview conversion failed');
    return false;
  }
  return true;
}

async function runPdfToPngWithPdftoppm(pdftoppm: string, pdfPath: string, outdir: string, width: number, timeoutMs: number): Promise<string[] | null> {
  await mkdir(outdir, { recursive: true, mode: 0o700 });
  const prefix = join(outdir, 'page');
  const dpi = Math.max(72, Math.min(240, Math.round(width / 8)));
  const result = await execFile(pdftoppm, [
    '-png',
    '-r',
    String(dpi),
    pdfPath,
    prefix,
  ], {
    cwd: outdir,
    timeout: timeoutMs,
  });

  if (result.exit_code !== 0 || result.timed_out) {
    logger.warn({
      path: pdfPath,
      exitCode: result.exit_code,
      timedOut: result.timed_out,
      stderr: result.stderr.slice(0, 500),
    }, 'pdftoppm preview conversion failed');
    return null;
  }
  return findGeneratedPngs(outdir);
}

async function runPdfToPngWithImageMagick(convert: string, pdfPath: string, outdir: string, width: number, timeoutMs: number): Promise<string[] | null> {
  await mkdir(outdir, { recursive: true, mode: 0o700 });
  const density = Math.max(72, Math.min(240, Math.round(width / 8)));
  const result = await execFile(convert, [
    '-density',
    String(density),
    pdfPath,
    join(outdir, 'page-%04d.png'),
  ], {
    cwd: outdir,
    timeout: timeoutMs,
  });

  if (result.exit_code !== 0 || result.timed_out) {
    logger.warn({
      path: pdfPath,
      exitCode: result.exit_code,
      timedOut: result.timed_out,
      stderr: result.stderr.slice(0, 500),
    }, 'ImageMagick preview conversion failed');
    return null;
  }
  return findGeneratedPngs(outdir);
}

async function runSofficePreview(inputPath: string, ext: string, tempDir: string, width: number, timeoutMs: number): Promise<{ pages: string[]; source: FilePreviewPngSequence['source'] } | null> {
  const soffice = await detectSoffice();
  const isPdf = PDF_PREVIEW_EXTENSIONS.has(ext);

  if (!soffice && !isPdf) {
    logger.info({ path: inputPath }, SOFFICE_PREVIEW_MESSAGE);
    return null;
  }

  let pdfPath = isPdf ? inputPath : null;
  if (!pdfPath && soffice) {
    const ok = await runSofficeConvert(soffice, inputPath, tempDir, 'pdf', timeoutMs);
    if (ok) pdfPath = await findGeneratedFile(tempDir, 'pdf');
  }

  if (pdfPath) {
    const pdftoppm = await detectExecutable('pdftoppm');
    if (pdftoppm) {
      const pages = await runPdfToPngWithPdftoppm(pdftoppm, pdfPath, join(tempDir, 'pdftoppm'), width, timeoutMs);
      if (pages?.length) return { pages, source: 'pdftoppm' };
    }

    const convert = await detectExecutable('convert');
    if (convert) {
      const pages = await runPdfToPngWithImageMagick(convert, pdfPath, join(tempDir, 'imagemagick'), width, timeoutMs);
      if (pages?.length) return { pages, source: 'imagemagick' };
    }
  }

  if (soffice) {
    const pngDir = join(tempDir, 'soffice-png');
    await mkdir(pngDir, { recursive: true, mode: 0o700 });
    const ok = await runSofficeConvert(soffice, pdfPath ?? inputPath, pngDir, 'png', timeoutMs);
    if (ok) {
      const pages = await findGeneratedPngs(pngDir);
      if (pages.length) return { pages, source: 'soffice' };
    }
  }

  return null;
}

export async function generateFilePreviewPngSequence(inputPath: string, options: FilePreviewOptions): Promise<FilePreviewPngSequence | null> {
  let tempDir: string | null = null;

  try {
    const width = normalizeWidth(options.width);
    if (!width) return null;

    const resolved = await resolveAllowedPreviewFile(inputPath);
    if (!resolved) return null;
    if (!isQuickLookPreviewExtension(resolved.path)) return null;

    const cacheDir = resolve(options.cacheDir ?? getFilePreviewCacheDir());
    await mkdir(cacheDir, { recursive: true, mode: 0o700 });

    const key = cacheKey(resolved.path, resolved.stats.mtimeMs, width);
    const cachePagesDir = join(cacheDir, `${key}.pages`);
    const cachedPages = await readCachedPreviewPages(cachePagesDir);
    if (cachedPages) return { pages: cachedPages, source: 'cache' };

    tempDir = join(cacheDir, `${key}.tmp-${process.pid}-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true, mode: 0o700 });

    const timeoutMs = options.timeoutMs ?? PREVIEW_TIMEOUT_MS;
    let generated: { pages: string[]; source: FilePreviewPngSequence['source'] } | null = null;
    const ext = normalizePreviewExt(resolved.path);
    if ((options.platform ?? process.platform) === 'darwin' && await isExecutable(QUICKLOOK_COMMAND)) {
      const pages = await runQuickLookPreview(resolved.path, tempDir, width, timeoutMs);
      if (pages?.length) generated = { pages, source: 'quicklook' };
    }

    if (!generated) generated = await runSofficePreview(resolved.path, ext, tempDir, width, timeoutMs);

    if (!generated?.pages.length) {
      logger.warn({ path: resolved.path, width }, 'File preview generation produced no PNG');
      return null;
    }

    const pages = await storePreviewPages(generated.pages, cachePagesDir);
    return { pages, source: generated.source };
  } catch (err) {
    logger.warn({
      path: inputPath,
      err: err instanceof Error ? err.message : String(err),
    }, 'File preview generation failed');
    return null;
  } finally {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export async function generateFilePreviewPng(inputPath: string, options: FilePreviewOptions): Promise<string | null> {
  const sequence = await generateFilePreviewPngSequence(inputPath, options);
  return sequence?.pages[0]?.path ?? null;
}
