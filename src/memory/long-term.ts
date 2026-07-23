import { getDb } from '../store/db.js';
import { getConfig } from '../config/index.js';
import { getMemoryEmbeddingProvider, getMemoryVectorStore } from './embedding-provider.js';
import type { MemoryDocument, VectorStore } from './vector-store.js';
import pino from 'pino';
import { hanTokenLength, isHanToken, tokenizeText } from './text-tokenizer.js';

/** Valid fact categories */
export type FactCategory = 'preference' | 'fact' | 'decision' | 'lesson';
export type MemoryFactStatus = 'active' | 'pending_review' | 'disputed' | 'retracted';
export type MemoryOriginKind = 'user' | 'tool' | 'assistant' | 'manual' | 'legacy';

/** A stored memory fact */
export interface MemoryFact {
  id: number;
  tenant_id: string;
  chat_id: string;
  user_id: string | null;
  category: FactCategory;
  key: string;
  value: string;
  confidence: number;
  salience_score: number;
  source: string | null;
  status: MemoryFactStatus;
  origin_kind: MemoryOriginKind;
  recall_count: number;
  last_recalled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SemanticFactHit {
  fact: MemoryFact;
  score: number;
  source: string | null;
  timestamp: string;
}

export interface MemoryAccessScope {
  userId: string;
  accessibleChatIds: string[];
}

const logger = pino({ name: 'mozi:memory:long-term' });

const MEMORY_FACT_COLUMNS = 'id, tenant_id, chat_id, user_id, category, key, value, confidence, salience_score, source, status, origin_kind, recall_count, last_recalled_at, created_at, updated_at';
const pendingVectorWrites = new Set<Promise<void>>();
let memoryFtsDb: object | null = null;
let memoryVectorStateDb: object | null = null;

function clampSalience(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0.01, Math.min(1, value));
}

function inferInitialSalience(
  category: FactCategory,
  key: string,
  source?: string,
  salienceHint?: number,
): number {
  if (typeof salienceHint === 'number') {
    return clampSalience(salienceHint);
  }
  if (key.startsWith('correction') || source?.includes('correction')) {
    return 0.95;
  }
  if (category === 'lesson') return 0.8;
  if (category === 'decision') return 0.7;
  if (category === 'preference') return 0.65;
  return 0.5;
}

function ensureMemoryFts(): void {
  const db = getDb();
  if (memoryFtsDb === db) return;
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_facts_fts USING fts5(
      fact_id UNINDEXED,
      tenant_id UNINDEXED,
      chat_id UNINDEXED,
      user_id UNINDEXED,
      category,
      key,
      value,
      tokenize = 'unicode61'
    );
    CREATE TRIGGER IF NOT EXISTS memory_facts_fts_insert AFTER INSERT ON memory_facts BEGIN
      INSERT INTO memory_facts_fts(fact_id, tenant_id, chat_id, user_id, category, key, value)
      VALUES (new.id, new.tenant_id, new.chat_id, new.user_id, new.category, new.key, new.value);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_facts_fts_update AFTER UPDATE ON memory_facts BEGIN
      DELETE FROM memory_facts_fts WHERE fact_id = old.id;
      INSERT INTO memory_facts_fts(fact_id, tenant_id, chat_id, user_id, category, key, value)
      VALUES (new.id, new.tenant_id, new.chat_id, new.user_id, new.category, new.key, new.value);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_facts_fts_delete AFTER DELETE ON memory_facts BEGIN
      DELETE FROM memory_facts_fts WHERE fact_id = old.id;
    END;
  `);
  // Triggers cover new writes. Backfill facts created before FTS existed.
  db.exec(`
    INSERT INTO memory_facts_fts(fact_id, tenant_id, chat_id, user_id, category, key, value)
    SELECT f.id, f.tenant_id, f.chat_id, f.user_id, f.category, f.key, f.value
    FROM memory_facts f
    WHERE NOT EXISTS (SELECT 1 FROM memory_facts_fts x WHERE x.fact_id = f.id);
  `);
  memoryFtsDb = db;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(value => value.length > 0))];
}

function buildFactAccessClause(scope: MemoryAccessScope | undefined): { sql: string; params: string[] } {
  if (!scope) return { sql: '', params: [] };

  const chatIds = uniqueStrings(scope.accessibleChatIds);
  const clauses = ['user_id = ?'];
  const params = [scope.userId];
  if (chatIds.length > 0) {
    clauses.push(`(user_id IS NULL AND chat_id IN (${chatIds.map(() => '?').join(',')}))`);
    params.push(...chatIds);
  }

  return {
    sql: ` AND (${clauses.join(' OR ')})`,
    params,
  };
}

function buildRecallCandidateChatIds(chatId: string, scope?: MemoryAccessScope): string[] {
  return uniqueStrings([chatId, '__semantic__', ...(scope?.accessibleChatIds ?? [])]);
}

function buildRecallAccessClause(
  tableAlias: string,
  candidateChatIds: string[],
  scope?: MemoryAccessScope,
): { sql: string; params: string[] } {
  const qualified = (column: string) => tableAlias ? `${tableAlias}.${column}` : column;
  const placeholders = candidateChatIds.map(() => '?').join(',');
  const chatClause = scope
    ? `(${qualified('chat_id')} IN (${placeholders}) OR ${qualified('user_id')} = ?)`
    : `${qualified('chat_id')} IN (${placeholders})`;
  const params = scope ? [...candidateChatIds, scope.userId] : [...candidateChatIds];
  const access = buildFactAccessClause(scope);
  return {
    sql: ` AND ${chatClause}${access.sql
      .replace(/\buser_id\b/g, qualified('user_id'))
      .replace(/\bchat_id\b/g, qualified('chat_id'))}`,
    params: [...params, ...access.params],
  };
}

function isChatAccessible(scope: MemoryAccessScope | undefined, chatId: string): boolean {
  if (!scope) return true;
  return scope.accessibleChatIds.includes(chatId);
}

function factToVectorDocument(fact: MemoryFact): MemoryDocument {
  return {
    id: String(fact.id),
    text: fact.value,
    embeddingText: `${fact.category} ${fact.key} ${fact.value}`,
    category: fact.category,
    key: fact.key,
    createdAt: Date.parse(fact.updated_at || fact.created_at) || Date.now(),
    tenantId: fact.tenant_id,
    chatId: fact.chat_id,
  };
}

function ensureMemoryVectorState(): void {
  const db = getDb();
  if (memoryVectorStateDb === db) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_vector_index_state (
      tenant_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  memoryVectorStateDb = db;
}

async function ensureTenantVectorIndex(tenantId: string): Promise<{ store: VectorStore; rebuilt: boolean } | null> {
  const db = getDb();
  const factCount = Number((db.prepare(
    "SELECT COUNT(*) AS count FROM memory_facts WHERE tenant_id = ? AND status = 'active'",
  ).get(tenantId) as { count?: number } | undefined)?.count ?? 0);
  if (factCount < getConfig().memory.semantic_activation_threshold) return null;

  const provider = getMemoryEmbeddingProvider(tenantId);
  if (!provider) return null;
  const store = await getMemoryVectorStore(tenantId);
  if (!store) return null;

  ensureMemoryVectorState();
  const state = db.prepare(`
    SELECT provider, model, dimensions
    FROM memory_vector_index_state
    WHERE tenant_id = ?
  `).get(tenantId) as { provider: string; model: string; dimensions: number } | undefined;
  const fingerprintMatches = state?.provider === provider.providerName
    && state.model === provider.modelName
    && state.dimensions === provider.dimensions;
  if (fingerprintMatches) return { store, rebuilt: false };

  const facts = db.prepare(`
    SELECT ${MEMORY_FACT_COLUMNS}
    FROM memory_facts
    WHERE tenant_id = ? AND status = 'active'
    ORDER BY id
  `).all(tenantId) as MemoryFact[];
  await store.replaceAll(facts.map(factToVectorDocument));
  db.prepare(`
    INSERT INTO memory_vector_index_state (tenant_id, provider, model, dimensions, indexed_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(tenant_id) DO UPDATE SET
      provider = excluded.provider,
      model = excluded.model,
      dimensions = excluded.dimensions,
      indexed_at = excluded.indexed_at
  `).run(tenantId, provider.providerName, provider.modelName, provider.dimensions);
  return { store, rebuilt: true };
}

function enqueueFactVectorSync(fact: MemoryFact): void {
  let task: Promise<void>;
  task = (async () => {
    if (fact.status !== 'active') {
      const store = await getMemoryVectorStore(fact.tenant_id);
      await store?.delete([String(fact.id)]);
      return;
    }
    const index = await ensureTenantVectorIndex(fact.tenant_id);
    if (!index || index.rebuilt) return;
    await index.store.upsert([factToVectorDocument(fact)]);
  })()
    .catch((err) => {
      logger.warn({
        factId: fact.id,
        err: err instanceof Error ? err.message : String(err),
      }, 'Memory fact vector sync failed');
    })
    .finally(() => {
      pendingVectorWrites.delete(task);
    });

  pendingVectorWrites.add(task);
}

export async function flushMemoryVectorWritesForTests(): Promise<void> {
  await Promise.allSettled([...pendingVectorWrites]);
}

/**
 * Save or update a fact in long-term memory (UPSERT).
 */
export function saveFact(
  chatId: string,
  category: FactCategory,
  key: string,
  value: string,
  source?: string,
  tenantId = 'default',
  userId?: string,
  salienceHint?: number,
  status: MemoryFactStatus = 'active',
  originKind: MemoryOriginKind = 'legacy',
): void {
  const db = getDb();
  const writePolicy = getConfig().memory.write_policy;
  const initialSalience = inferInitialSalience(category, key, source, salienceHint);
  if (writePolicy === 'first_write_wins') {
    db.prepare(`
      INSERT INTO memory_facts (tenant_id, chat_id, user_id, category, key, value, confidence, salience_score, source, status, origin_kind)
      VALUES (?, ?, ?, ?, ?, ?, 1.0, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, chat_id, category, key) DO NOTHING
    `).run(tenantId, chatId, userId ?? null, category, key, value, initialSalience, source ?? null, status, originKind);
  } else {
    db.prepare(`
      INSERT INTO memory_facts (tenant_id, chat_id, user_id, category, key, value, confidence, salience_score, source, status, origin_kind)
      VALUES (?, ?, ?, ?, ?, ?, 1.0, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, chat_id, category, key)
      DO UPDATE SET value = excluded.value, source = excluded.source,
                    user_id = COALESCE(excluded.user_id, user_id),
                    status = excluded.status,
                    origin_kind = excluded.origin_kind,
                    salience_score = salience_score * 0.7 + excluded.salience_score * 0.3,
                    updated_at = datetime('now')
    `).run(tenantId, chatId, userId ?? null, category, key, value, initialSalience, source ?? null, status, originKind);
  }

  const fact = db.prepare(`
    SELECT ${MEMORY_FACT_COLUMNS}
    FROM memory_facts
    WHERE tenant_id = ? AND chat_id = ? AND category = ? AND key = ?
    LIMIT 1
  `).get(tenantId, chatId, category, key) as MemoryFact | undefined;
  if (fact) {
    ensureMemoryFts();
    enqueueFactVectorSync(fact);
  }
}

/**
 * Get facts from long-term memory, optionally filtered by category.
 */
export function getFacts(
  chatId: string,
  category?: FactCategory,
  tenantId = 'default',
  scope?: MemoryAccessScope,
  includeInactive = false,
): MemoryFact[] {
  const db = getDb();
  const access = buildFactAccessClause(scope);
  const statusClause = includeInactive ? '' : " AND status = 'active'";
  if (category) {
    return db.prepare(`
      SELECT ${MEMORY_FACT_COLUMNS}
      FROM memory_facts
      WHERE tenant_id = ? AND chat_id = ? AND category = ?${statusClause}
        ${access.sql}
      ORDER BY salience_score DESC, updated_at DESC
    `).all(tenantId, chatId, category, ...access.params) as MemoryFact[];
  }
  return db.prepare(`
    SELECT ${MEMORY_FACT_COLUMNS}
    FROM memory_facts
    WHERE tenant_id = ? AND chat_id = ?${statusClause}
      ${access.sql}
    ORDER BY category, salience_score DESC, updated_at DESC
  `).all(tenantId, chatId, ...access.params) as MemoryFact[];
}

/**
 * Get facts by user_id — enables cross-session memory retrieval.
 * Falls back to chat_id-based query when no results found by user_id.
 */
export function getFactsByUser(
  userId: string,
  tenantId = 'default',
  category?: FactCategory,
  includeInactive = false,
): MemoryFact[] {
  const db = getDb();
  const statusClause = includeInactive ? '' : " AND status = 'active'";
  if (category) {
    return db.prepare(`
      SELECT ${MEMORY_FACT_COLUMNS}
      FROM memory_facts
      WHERE tenant_id = ? AND user_id = ? AND category = ?${statusClause}
      ORDER BY salience_score DESC, updated_at DESC
    `).all(tenantId, userId, category) as MemoryFact[];
  }
  return db.prepare(`
    SELECT ${MEMORY_FACT_COLUMNS}
    FROM memory_facts
    WHERE tenant_id = ? AND user_id = ?${statusClause}
    ORDER BY category, salience_score DESC, updated_at DESC
  `).all(tenantId, userId) as MemoryFact[];
}

/**
 * List every fact the caller can access, WITHOUT pinning a single chat_id.
 *
 * The per-chat `getFacts` is wrong for a "show me everything you remember about
 * me" browser: real facts are stored under each session's chat_id (and the
 * user's own id), never under a synthetic 'global' chat, so a chat-pinned query
 * returns an empty list. This uses only the access clause (user_id OR
 * chat_id IN accessible) so the browser surfaces the user's actual memory.
 * With no scope (single-user local mode) it returns all tenant facts.
 */
export function getAccessibleFacts(
  tenantId = 'default',
  scope?: MemoryAccessScope,
  category?: FactCategory,
  includeInactive = false,
): MemoryFact[] {
  const db = getDb();
  const access = buildFactAccessClause(scope);
  const catClause = category ? ' AND category = ?' : '';
  const statusClause = includeInactive ? '' : " AND status = 'active'";
  const params = category
    ? [tenantId, category, ...access.params]
    : [tenantId, ...access.params];
  return db.prepare(`
    SELECT ${MEMORY_FACT_COLUMNS}
    FROM memory_facts
    WHERE tenant_id = ?${catClause}${statusClause}${access.sql}
    ORDER BY category, salience_score DESC, updated_at DESC
  `).all(...params) as MemoryFact[];
}

/**
 * Update the value of a single fact the caller owns, then re-embed it so
 * semantic recall reflects the correction. Access-scoped exactly like
 * deleteFactById (no chat_id pin). Returns the updated fact, or null if the
 * fact does not exist or is not accessible to the caller.
 */
export function updateFactValue(
  factId: number,
  value: string,
  tenantId = 'default',
  scope?: MemoryAccessScope,
): MemoryFact | null {
  const db = getDb();
  const access = buildFactAccessClause(scope);
  const result = db.prepare(`
    UPDATE memory_facts
    SET value = ?, source = 'user_edit', updated_at = datetime('now')
    WHERE id = ? AND tenant_id = ?
      ${access.sql}
  `).run(value, factId, tenantId, ...access.params);
  if (result.changes === 0) return null;
  const fact = db.prepare(`
    SELECT ${MEMORY_FACT_COLUMNS} FROM memory_facts WHERE id = ? AND tenant_id = ?
  `).get(factId, tenantId) as MemoryFact | undefined;
  if (!fact) return null;
  ensureMemoryFts();
  enqueueFactVectorSync(fact);
  return fact;
}

function memorySearchTerms(query: string): string[] {
  return tokenizeText(query).slice(0, 24);
}

function ftsQuery(terms: string[]): string {
  return terms
    .filter(term => /^[a-z0-9]+$/i.test(term))
    .map(term => `"${term.replaceAll('"', '""')}"`)
    .join(' OR ');
}

function rowToFact(row: Record<string, unknown>): MemoryFact {
  return {
    id: Number(row.id),
    tenant_id: row.tenant_id as string,
    chat_id: row.chat_id as string,
    user_id: (row.user_id as string | null) ?? null,
    category: row.category as FactCategory,
    key: row.key as string,
    value: row.value as string,
    confidence: Number(row.confidence ?? 0),
    salience_score: Number(row.salience_score ?? 0.5),
    source: (row.source as string | null) ?? null,
    status: (row.status as MemoryFactStatus | undefined) ?? 'active',
    origin_kind: (row.origin_kind as MemoryOriginKind | undefined) ?? 'legacy',
    recall_count: Number(row.recall_count ?? 0),
    last_recalled_at: (row.last_recalled_at as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

/**
 * Local, deterministic memory search. The historical name remains for API
 * compatibility, but this no longer pretends a hand-written hash is a semantic
 * embedding. SQLite FTS is the normal search path for small memory sets.
 */
export function searchSemanticFacts(
  chatId: string,
  query: string,
  tenantId = 'default',
  topK?: number,
  minScore?: number,
  scope?: MemoryAccessScope,
): SemanticFactHit[] {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return [];
  ensureMemoryFts();

  const config = getConfig().memory;
  const effectiveTopK = Math.max(1, Math.min(50, Math.floor(topK ?? config.semantic_top_k)));
  const effectiveMinScore = minScore ?? config.semantic_min_score;
  const db = getDb();
  const candidateChatIds = buildRecallCandidateChatIds(chatId, scope);
  const access = buildRecallAccessClause('f', candidateChatIds, scope);
  const terms = memorySearchTerms(normalizedQuery);
  const match = ftsQuery(terms);
  const rows = match
    ? db.prepare(`
        SELECT f.*, bm25(memory_facts_fts, 0.0, 2.0, 1.0) AS fts_rank
        FROM memory_facts_fts
        JOIN memory_facts f ON f.id = CAST(memory_facts_fts.fact_id AS INTEGER)
        WHERE memory_facts_fts MATCH ?
          AND f.tenant_id = ?
          AND f.status = 'active'
          ${access.sql}
        ORDER BY fts_rank ASC, f.updated_at DESC
        LIMIT ?
      `).all(match, tenantId, ...access.params, effectiveTopK) as Array<Record<string, unknown>>
    : [];

  let hits = rows.map(row => {
    const fact = rowToFact(row);
    const rank = Math.abs(Number(row.fts_rank ?? 0));
    // FTS5 bm25() is negative and sorts ascending: a larger magnitude is a
    // stronger match. Keep that ordering when hits later merge with CJK rows.
    return { fact, score: 1 + rank, source: fact.source, timestamp: fact.updated_at };
  });

  // unicode61 indexes a contiguous Han run as one token, so CJK word queries
  // cannot use MATCH. Always merge a scoped word-level lexical branch when
  // multi-code-point Han terms exist, including mixed CJK/ASCII queries.
  // Single-Han-only queries deliberately skip LIKE: they are too noisy to
  // satisfy a truthful relevance claim.
  const cjkTerms = terms
    .filter(term => isHanToken(term) && hanTokenLength(term) >= 2)
    .slice(0, 8);
  if (cjkTerms.length > 0) {
    const matchExpression = cjkTerms
      .map(() => `CASE WHEN lower(f.key || ' ' || f.value) LIKE ? THEN 1 ELSE 0 END`)
      .join(' + ');
    const likeParams = cjkTerms.map(term => `%${term}%`);
    const minRequired = cjkTerms.length > 1 ? 2 : 1;
    const lexicalRows = db.prepare(`
      WITH lexical_candidates AS (
        SELECT f.*, (${matchExpression}) AS lexical_matches
        FROM memory_facts f
        WHERE f.tenant_id = ?
          AND f.status = 'active'
          ${access.sql}
      )
      SELECT * FROM lexical_candidates
      WHERE lexical_matches >= ?
      ORDER BY lexical_matches DESC, updated_at DESC, id DESC
      LIMIT ?
    `).all(...likeParams, tenantId, ...access.params, minRequired, effectiveTopK) as Array<Record<string, unknown>>;
    const lexicalHits = lexicalRows.map(row => {
      const fact = rowToFact(row);
      const matched = Number(row.lexical_matches ?? 0);
      return { fact, score: matched / cjkTerms.length, source: fact.source, timestamp: fact.updated_at };
    });
    const merged = new Map(hits.map(hit => [hit.fact.id, hit]));
    for (const hit of lexicalHits) {
      const existing = merged.get(hit.fact.id);
      if (!existing || hit.score > existing.score) merged.set(hit.fact.id, hit);
    }
    hits = [...merged.values()];
  }

  return hits
    .filter(hit => hit.score >= effectiveMinScore)
    .sort((a, b) => (
      b.score - a.score
      || Date.parse(b.timestamp) - Date.parse(a.timestamp)
      || b.fact.id - a.fact.id
    ))
    .slice(0, effectiveTopK);
}

/**
 * Enhanced recall: uses VectorStore hybrid search when available,
 * falls back to built-in searchSemanticFacts otherwise.
 */
export async function recallFacts(
  chatId: string,
  query: string,
  tenantId = 'default',
  topK = 20,
  scope?: MemoryAccessScope,
): Promise<SemanticFactHit[]> {
  const candidateChatIds = buildRecallCandidateChatIds(chatId, scope);
  const access = buildRecallAccessClause('f', candidateChatIds, scope);
  const accessibleCount = Number((getDb().prepare(`
    SELECT COUNT(*) AS count FROM memory_facts f
    WHERE f.tenant_id = ? AND f.status = 'active' ${access.sql}
  `).get(tenantId, ...access.params) as { count?: number } | undefined)?.count ?? 0);
  const threshold = getConfig().memory.semantic_activation_threshold;
  const vectorStore = accessibleCount >= threshold
    ? (await ensureTenantVectorIndex(tenantId))?.store ?? null
    : null;

  if (vectorStore) {
    try {
      const results = await vectorStore.searchHybrid(query, {
        topK,
        vectorWeight: 0.7,
        keywordWeight: 0.3,
        temporalDecay: true,
        decayHalfLifeDays: 30,
        tenantId,
        chatIds: candidateChatIds,
      });

      const factIds = [...new Set(results
        .map(result => Number.parseInt(result.id, 10))
        .filter(id => Number.isInteger(id) && id > 0))];

      if (factIds.length > 0) {
        const db = getDb();
        const idPlaceholders = factIds.map(() => '?').join(',');
        const access = buildRecallAccessClause('f', candidateChatIds, scope);
        const facts = db.prepare(`
          SELECT ${MEMORY_FACT_COLUMNS}
          FROM memory_facts f
          WHERE f.tenant_id = ?
            AND f.status = 'active'
            AND f.id IN (${idPlaceholders})
            ${access.sql}
        `).all(tenantId, ...factIds, ...access.params) as MemoryFact[];
        const factsById = new Map(facts.map(fact => [fact.id, fact]));
        const hits = results
          .map((result): SemanticFactHit | null => {
            const id = Number.parseInt(result.id, 10);
            const fact = factsById.get(id);
            if (!fact) return null;
            return {
              fact,
              score: result.score,
              source: result.source,
              timestamp: fact.updated_at,
            };
          })
          .filter((hit): hit is SemanticFactHit => Boolean(hit));

        if (hits.length > 0) {
          return hits;
        }
      }

      logger.debug({ chatId, tenantId }, 'Vector memory recall returned no usable facts; using keyword fact recall');
    } catch (err) {
      logger.warn({
        chatId,
        tenantId,
        err: err instanceof Error ? err.message : String(err),
      }, 'Vector memory recall failed; using keyword fact recall');
    }
  } else {
    logger.debug({ chatId, tenantId }, 'Vector memory provider unavailable; using keyword fact recall');
  }

  // Normal path for small memories and honest fallback for unavailable vectors.
  return searchSemanticFacts(chatId, query, tenantId, topK, undefined, scope);
}

/**
 * Delete a specific fact from long-term memory.
 */
export function deleteFact(
  chatId: string,
  category: FactCategory,
  key: string,
  tenantId = 'default',
): void {
  const db = getDb();
  db.prepare(`
    DELETE FROM memory_facts
    WHERE tenant_id = ? AND chat_id = ? AND category = ? AND key = ?
  `).run(tenantId, chatId, category, key);
}

/**
 * Delete a fact by its numeric ID.
 * Returns true if a row was actually deleted.
 */
export function deleteFactById(
  factId: number,
  tenantId = 'default',
  scope?: MemoryAccessScope,
): boolean {
  const db = getDb();
  const access = buildFactAccessClause(scope);
  const result = db.prepare(`
    DELETE FROM memory_facts
    WHERE id = ? AND tenant_id = ?
      ${access.sql}
  `).run(factId, tenantId, ...access.params);
  return result.changes > 0;
}

/** Set a fact's trust lifecycle state while preserving access controls. */
export function updateFactStatus(
  factId: number,
  status: MemoryFactStatus,
  tenantId = 'default',
  scope?: MemoryAccessScope,
  originKind?: MemoryOriginKind,
  promotion?: { chatId: string; userId: string },
): MemoryFact | null {
  const db = getDb();
  const access = buildFactAccessClause(scope);
  const result = db.prepare(`
    UPDATE memory_facts
    SET status = ?,
        origin_kind = COALESCE(?, origin_kind),
        chat_id = COALESCE(?, chat_id),
        user_id = COALESCE(?, user_id),
        source = CASE WHEN ? = 'active' THEN 'user_edit' ELSE source END,
        updated_at = datetime('now')
    WHERE id = ? AND tenant_id = ?${access.sql}
  `).run(
    status,
    originKind ?? null,
    promotion?.chatId ?? null,
    promotion?.userId ?? null,
    status,
    factId,
    tenantId,
    ...access.params,
  );
  if (result.changes === 0) return null;
  const fact = db.prepare(`
    SELECT ${MEMORY_FACT_COLUMNS} FROM memory_facts WHERE id = ? AND tenant_id = ?
  `).get(factId, tenantId) as MemoryFact | null;
  if (fact) enqueueFactVectorSync(fact);
  return fact;
}

/**
 * Delete every fact the caller can access (the "clear all my memory" action).
 * Access-scoped like deleteFactById — never touches other users' facts. With no
 * scope (single-user local mode) it clears all facts for the tenant. Returns the
 * number of deleted facts.
 */
export function deleteAllAccessibleFacts(
  tenantId = 'default',
  scope?: MemoryAccessScope,
): number {
  const db = getDb();
  const access = buildFactAccessClause(scope);
  const result = db.prepare(`
    DELETE FROM memory_facts
    WHERE tenant_id = ?
      ${access.sql}
  `).run(tenantId, ...access.params);
  return result.changes;
}

/**
 * Batch-update recall tracking for selected facts.
 * Called by context-builder after choosing which facts to include.
 */
export function recordRecall(factIds: number[]): void {
  if (factIds.length === 0) return;
  const db = getDb();
  const placeholders = factIds.map(() => '?').join(',');
  db.prepare(`
    UPDATE memory_facts
    SET recall_count = recall_count + 1,
        last_recalled_at = datetime('now')
    WHERE id IN (${placeholders})
  `).run(...factIds);
}

/**
 * Decay confidence of facts that haven't been recalled recently.
 * Halves confidence but enforces a floor of 0.1.
 * Returns the number of facts decayed.
 */
export function decayUnusedFacts(
  tenantId = 'default',
  daysThreshold = 30,
): number {
  const db = getDb();
  const result = db.prepare(`
    UPDATE memory_facts
    SET confidence = MAX(0.1, confidence * 0.5),
        salience_score = MAX(0.01, salience_score * 0.9)
    WHERE tenant_id = ?
      AND status = 'active'
      AND (
        last_recalled_at < datetime('now', '-' || ? || ' days')
        OR (last_recalled_at IS NULL AND updated_at < datetime('now', '-' || ? || ' days'))
      )
      AND (confidence > 0.1 OR salience_score > 0.01)
  `).run(tenantId, daysThreshold, daysThreshold);
  return result.changes;
}

/**
 * Consolidate episodic facts that appear across multiple chats into semantic memory.
 * Facts with the same category+key in >= minOccurrences distinct chats
 * get upserted into the '__semantic__' chat_id with averaged confidence.
 * Returns the number of consolidated facts.
 */
export function consolidateEpisodes(
  tenantId = 'default',
  minOccurrences = 3,
): number {
  const db = getDb();
  const rows = db.prepare(`
    SELECT category, key, COUNT(DISTINCT chat_id) as cnt, GROUP_CONCAT(DISTINCT value) as merged_values,
           AVG(confidence) as avg_confidence,
           AVG(salience_score) as avg_salience
    FROM memory_facts
    WHERE tenant_id = ? AND chat_id != '__semantic__' AND status = 'active'
    GROUP BY category, key
    HAVING cnt >= ?
  `).all(tenantId, minOccurrences) as Array<{
    category: FactCategory;
    key: string;
    cnt: number;
    merged_values: string;
    avg_confidence: number;
    avg_salience: number;
  }>;

  const upsert = db.prepare(`
    INSERT INTO memory_facts (tenant_id, chat_id, category, key, value, confidence, salience_score, source)
    VALUES (?, '__semantic__', ?, ?, ?, ?, ?, 'consolidation')
    ON CONFLICT(tenant_id, chat_id, category, key)
    DO UPDATE SET value = excluded.value, confidence = excluded.confidence, salience_score = excluded.salience_score,
                  updated_at = datetime('now')
  `);

  for (const row of rows) {
    upsert.run(tenantId, row.category, row.key, row.merged_values, row.avg_confidence, clampSalience(row.avg_salience));
  }

  // Keep vector index in sync with newly consolidated semantic facts.
  const semanticFacts = getFacts('__semantic__', undefined, tenantId);
  for (const fact of semanticFacts) {
    enqueueFactVectorSync(fact);
  }
  return rows.length;
}

/**
 * Remove stale facts with very low confidence that haven't been recalled recently.
 * Returns the number of pruned facts.
 */
export function pruneStale(
  tenantId = 'default',
  confidenceThreshold = 0.1,
  daysSinceRecall = 60,
): number {
  const db = getDb();
  const result = db.prepare(`
    DELETE FROM memory_facts
    WHERE tenant_id = ?
      AND status = 'active'
      AND confidence <= ?
      AND (
        last_recalled_at < datetime('now', '-' || ? || ' days')
        OR (last_recalled_at IS NULL AND updated_at < datetime('now', '-' || ? || ' days'))
      )
  `).run(tenantId, confidenceThreshold, daysSinceRecall, daysSinceRecall);
  return result.changes;
}

/**
 * Prune low-salience episodic facts and preserve a semantic consolidation record.
 * Returns the number of deleted episodic facts.
 */
export function pruneLowSalienceFacts(
  tenantId = 'default',
  salienceThreshold = 0.1,
  minAgeDays = 30,
): number {
  const db = getDb();
  const candidates = db.prepare(`
    SELECT id, category, key, value, confidence, salience_score
    FROM memory_facts
    WHERE tenant_id = ?
      AND status = 'active'
      AND chat_id != '__semantic__'
      AND salience_score <= ?
      AND (
        last_recalled_at < datetime('now', '-' || ? || ' days')
        OR (last_recalled_at IS NULL AND updated_at < datetime('now', '-' || ? || ' days'))
      )
  `).all(tenantId, salienceThreshold, minAgeDays, minAgeDays) as Array<{
    id: number;
    category: FactCategory;
    key: string;
    value: string;
    confidence: number;
    salience_score: number;
  }>;

  if (candidates.length === 0) return 0;

  const grouped = new Map<string, {
    category: FactCategory;
    key: string;
    values: Set<string>;
    confidenceTotal: number;
    salienceTotal: number;
    count: number;
  }>();

  for (const fact of candidates) {
    const groupKey = `${fact.category}:${fact.key}`;
    const existing = grouped.get(groupKey) ?? {
      category: fact.category,
      key: fact.key,
      values: new Set<string>(),
      confidenceTotal: 0,
      salienceTotal: 0,
      count: 0,
    };
    if (fact.value.trim().length > 0) {
      existing.values.add(fact.value.trim());
    }
    existing.confidenceTotal += fact.confidence;
    existing.salienceTotal += fact.salience_score;
    existing.count += 1;
    grouped.set(groupKey, existing);
  }

  const upsert = db.prepare(`
    INSERT INTO memory_facts (tenant_id, chat_id, category, key, value, confidence, salience_score, source)
    VALUES (?, '__semantic__', ?, ?, ?, ?, ?, 'forgetting_consolidation')
    ON CONFLICT(tenant_id, chat_id, category, key)
    DO UPDATE SET
      value = CASE
        WHEN memory_facts.value = excluded.value THEN memory_facts.value
        WHEN length(memory_facts.value) > 0 THEN memory_facts.value || ' | ' || excluded.value
        ELSE excluded.value
      END,
      confidence = MAX(memory_facts.confidence, excluded.confidence),
      salience_score = memory_facts.salience_score * 0.7 + excluded.salience_score * 0.3,
      source = 'forgetting_consolidation',
      updated_at = datetime('now')
  `);
  const deleteById = db.prepare('DELETE FROM memory_facts WHERE id = ?');

  const tx = db.transaction(() => {
    for (const entry of grouped.values()) {
      const mergedValue = [...entry.values].slice(0, 5).join(' | ').slice(0, 2000);
      if (mergedValue.length === 0) continue;
      upsert.run(
        tenantId,
        entry.category,
        entry.key,
        mergedValue,
        entry.confidenceTotal / entry.count,
        clampSalience(entry.salienceTotal / entry.count),
      );
    }

    for (const row of candidates) {
      deleteById.run(row.id);
    }
  });
  tx();

  const semanticFacts = getFacts('__semantic__', undefined, tenantId);
  for (const fact of semanticFacts) {
    enqueueFactVectorSync(fact);
  }

  return candidates.length;
}
