import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { ensureToolWorkspaceDir, resolveWritePath } from '../tools/tool-utils.js';
import { getDb } from '../store/db.js';

export type PersistableArtifactContentType = 'markdown' | 'html';

export interface ArtifactVersionRecord {
  id: string;
  artifact_id: string;
  version_number: number;
  content: string;
  persisted_path: string;
  created_at: number;
  change_description?: string;
}

export interface ArtifactVersionIdentity {
  artifactId: string;
  versionNumber?: number;
}

interface PersistArtifactPathInput {
  title: string;
  contentType: PersistableArtifactContentType;
  chatId?: string;
  sessionId?: string;
}

interface PersistArtifactContentInput extends PersistArtifactPathInput {
  content: string;
  userId?: string;
}

interface FindPersistedPathInput {
  persistedPath: string;
  tenantId?: string;
  chatId?: string;
  sessionId?: string;
}

function normalizePathKey(path: string): string {
  return resolve(path).replace(/\\/g, '/');
}

function slugPathSegment(value: string, fallback: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 80);
  return normalized || fallback;
}

function extensionForContentType(contentType: PersistableArtifactContentType): string {
  return contentType === 'html' ? 'html' : 'md';
}

function toVersionRecord(row: Record<string, unknown> | undefined): ArtifactVersionRecord | null {
  if (!row) return null;
  const id = typeof row.id === 'string' ? row.id : '';
  const artifactId = typeof row.artifact_id === 'string' ? row.artifact_id : '';
  const versionNumber = typeof row.version_number === 'number' ? row.version_number : Number(row.version_number ?? 0);
  const content = typeof row.content === 'string' ? row.content : '';
  const persistedPath = typeof row.persisted_path === 'string' ? row.persisted_path : '';
  const createdAt = typeof row.created_at === 'number' ? row.created_at : Number(row.created_at ?? 0);
  if (!id || !artifactId || !Number.isFinite(versionNumber) || !persistedPath) return null;
  return {
    id,
    artifact_id: artifactId,
    version_number: versionNumber,
    content,
    persisted_path: persistedPath,
    created_at: Number.isFinite(createdAt) ? createdAt : 0,
    change_description: typeof row.change_description === 'string' ? row.change_description : undefined,
  };
}

function parsePersistedArtifact(content: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const artifact = parsed as Record<string, unknown>;
  return artifact._artifact === true ? artifact : null;
}

function artifactData(artifact: Record<string, unknown>): Record<string, unknown> {
  const data = artifact.data;
  return data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {};
}

export function persistedPathFromArtifactRecord(artifact: Record<string, unknown>): string {
  const data = artifactData(artifact);
  const path = artifact.persisted_path ?? data.persisted_path;
  return typeof path === 'string' ? path : '';
}

export function parentArtifactIdFromRecord(artifact: Record<string, unknown>): string {
  const parentId = artifact.parent_id;
  if (typeof parentId === 'string' && parentId.trim()) return parentId;
  const id = artifact.id;
  return typeof id === 'string' ? id : '';
}

export function isPersistableArtifactContentType(contentType: string): contentType is PersistableArtifactContentType {
  return contentType === 'markdown' || contentType === 'html';
}

export function buildArtifactPersistedRelativePath(input: PersistArtifactPathInput): string {
  const scopeSource = input.sessionId ?? input.chatId ?? 'local';
  const scope = slugPathSegment(scopeSource, 'local');
  const titleSlug = slugPathSegment(input.title, 'artifact');
  // CJK-heavy titles often collapse to the same ASCII fragment (for example
  // several unrelated “2026 Q2” reports). Preserve readable slugs while using
  // the full title as stable collision identity. Equal titles still map to the
  // same path and therefore retain explicit versioning semantics.
  const titleHash = createHash('sha256').update(input.title).digest('hex').slice(0, 10);
  const title = `${titleSlug}-${titleHash}`;
  const ext = extensionForContentType(input.contentType);
  return `artifacts/${scope}/${title}.${ext}`;
}

export async function persistArtifactContent(input: PersistArtifactContentInput): Promise<string> {
  await ensureToolWorkspaceDir(input.userId);
  const relativePath = buildArtifactPersistedRelativePath(input);
  return persistArtifactContentToPath(relativePath, input.content, input.userId);
}

export async function persistArtifactContentToPath(
  path: string,
  content: string,
  userId?: string,
): Promise<string> {
  await ensureToolWorkspaceDir(userId);
  const resolvedPath = resolveWritePath(path, userId);
  mkdirSync(dirname(resolvedPath), { recursive: true, mode: 0o700 });
  writeFileSync(resolvedPath, content, 'utf-8');
  return resolve(resolvedPath);
}

export function findLatestArtifactIdentityByPersistedPath(
  input: FindPersistedPathInput,
): ArtifactVersionIdentity | null {
  const db = getDb();
  const where = ['tenant_id = ?', 'role = ?', 'content LIKE ?'];
  const params: unknown[] = [input.tenantId ?? 'default', 'tool', '%"_artifact":true%'];
  if (input.sessionId) {
    where.push('session_id = ?');
    params.push(input.sessionId);
  } else if (input.chatId) {
    where.push('chat_id = ?');
    params.push(input.chatId);
  } else {
    return null;
  }

  const rows = db.prepare(`
    SELECT content
    FROM conversations
    WHERE ${where.join(' AND ')}
    ORDER BY id DESC
    LIMIT 100
  `).all(...params) as Array<{ content: string }>;

  const targetPath = normalizePathKey(input.persistedPath);
  for (const row of rows) {
    const artifact = parsePersistedArtifact(row.content);
    if (!artifact) continue;
    const persistedPath = persistedPathFromArtifactRecord(artifact);
    if (!persistedPath || normalizePathKey(persistedPath) !== targetPath) continue;
    const artifactId = parentArtifactIdFromRecord(artifact);
    if (!artifactId) continue;
    const versionNumber = typeof artifact.version_number === 'number' ? artifact.version_number : undefined;
    return { artifactId, versionNumber };
  }
  return null;
}

/**
 * Resolve an artifact's newest version *within a tenant*.
 *
 * `tenantId` is required rather than defaulted: the only caller is
 * `update_artifact`, which takes `artifact_id` straight from the model, so an
 * unscoped lookup resolves whichever tenant owns that id. Isolation previously
 * rested entirely on the filesystem write gate downstream — and that gate is a
 * no-op when `tools.fs.workspace_only` is disabled (tool-utils.ts:95), leaving
 * nothing between tenants. Making the parameter required means a caller that
 * forgets it fails to compile instead of silently reading across tenants.
 */
export function getLatestArtifactVersion(
  artifactIdOrVersionId: string,
  tenantId: string,
): ArtifactVersionRecord | null {
  const db = getDb();
  const versionRow = db.prepare(`
    SELECT artifact_id
    FROM artifact_versions
    WHERE id = ? AND tenant_id = ?
    LIMIT 1
  `).get(artifactIdOrVersionId, tenantId) as { artifact_id?: string } | undefined;
  const artifactId = typeof versionRow?.artifact_id === 'string' && versionRow.artifact_id
    ? versionRow.artifact_id
    : artifactIdOrVersionId;
  const row = db.prepare(`
    SELECT id, artifact_id, version_number, content, persisted_path, created_at, change_description
    FROM artifact_versions
    WHERE artifact_id = ? AND tenant_id = ?
    ORDER BY version_number DESC, created_at DESC
    LIMIT 1
  `).get(artifactId, tenantId) as Record<string, unknown> | undefined;
  return toVersionRecord(row);
}

export function getNextArtifactVersionNumber(artifactId: string, tenantId: string): number {
  const db = getDb();
  const row = db.prepare(`
    SELECT COALESCE(MAX(version_number), 0) AS latest
    FROM artifact_versions
    WHERE artifact_id = ? AND tenant_id = ?
  `).get(artifactId, tenantId) as { latest?: number } | undefined;
  return Number(row?.latest ?? 0) + 1;
}

export function insertArtifactVersion(input: {
  id: string;
  artifactId: string;
  /** Required so a row can never be written without the identity reads filter on. */
  tenantId: string;
  versionNumber: number;
  content: string;
  persistedPath: string;
  changeDescription?: string;
  createdAt?: number;
}): ArtifactVersionRecord {
  const record: ArtifactVersionRecord = {
    id: input.id,
    artifact_id: input.artifactId,
    version_number: input.versionNumber,
    content: input.content,
    persisted_path: input.persistedPath,
    created_at: input.createdAt ?? Date.now(),
    change_description: input.changeDescription,
  };
  const db = getDb();
  db.prepare(`
    INSERT INTO artifact_versions (
      id, artifact_id, tenant_id, version_number, content, persisted_path, created_at, change_description
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.artifact_id,
    input.tenantId,
    record.version_number,
    record.content,
    record.persisted_path,
    record.created_at,
    record.change_description ?? null,
  );
  return record;
}
