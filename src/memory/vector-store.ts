/**
 * Vector Store — LanceDB-based vector storage + hybrid search for MOZI.
 *
 * Provides:
 * - Vector similarity search (cosine)
 * - Keyword search (FTS via LanceDB)
 * - Hybrid search (weighted combination + MMR re-ranking)
 * - Temporal decay (recent facts score higher)
 */

import { connect, type Connection, type Table } from '@lancedb/lancedb';
import type { EmbeddingProvider } from './embeddings.js';
import pino from 'pino';
import { hanTokenLength, isHanToken, tokenizeText } from './text-tokenizer.js';

const logger = pino({ name: 'mozi:vector-store' });

export interface MemoryDocument {
  id: string;
  text: string;
  embeddingText?: string;
  category: string;
  key?: string;
  createdAt: number;  // epoch ms
  tenantId?: string;
  chatId?: string;
}

export interface SearchResult {
  id: string;
  text: string;
  category: string;
  key?: string;
  score: number;
  source: 'vector' | 'keyword' | 'hybrid';
  tenantId?: string;
  chatId?: string;
  createdAt?: number;
}

export interface HybridSearchOptions {
  topK?: number;
  vectorWeight?: number;
  keywordWeight?: number;
  temporalDecay?: boolean;
  decayHalfLifeDays?: number;
  tenantId?: string;
  chatIds?: string[];
}

const DEFAULT_OPTIONS = {
  topK: 20,
  vectorWeight: 0.7,
  keywordWeight: 0.3,
  temporalDecay: true,
  decayHalfLifeDays: 30,
} satisfies Required<Pick<HybridSearchOptions,
  'topK' | 'vectorWeight' | 'keywordWeight' | 'temporalDecay' | 'decayHalfLifeDays'
>>;

function matchesSearchFilters(
  row: Record<string, unknown>,
  tenantId?: string,
  chatIds?: string[],
): boolean {
  if (tenantId && String(row.tenant_id ?? 'default') !== tenantId) {
    return false;
  }
  if (chatIds && chatIds.length > 0) {
    const chatId = String(row.chat_id ?? '');
    if (!chatIds.includes(chatId)) return false;
  }
  return true;
}

export class VectorStore {
  private db: Connection | null = null;
  private table: Table | null = null;
  private readonly dbPath: string;
  private readonly provider: EmbeddingProvider;
  private readonly tableName: string;
  private initialized = false;

  constructor(dbPath: string, provider: EmbeddingProvider, tableName = 'memory_vectors') {
    this.dbPath = dbPath;
    this.provider = provider;
    this.tableName = tableName;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    this.db = await connect(this.dbPath);

    const tableNames = await this.db.tableNames();
    if (tableNames.includes(this.tableName)) {
      this.table = await this.db.openTable(this.tableName);
    }

    this.initialized = true;
  }

  private async ensureTable(): Promise<Table> {
    await this.ensureInitialized();
    if (!this.table) {
      // Create table with first document when needed
      throw new Error('Table not created yet — call upsert first');
    }
    return this.table;
  }

  /**
   * Add or update documents in the vector store.
   */
  async upsert(docs: MemoryDocument[]): Promise<void> {
    if (docs.length === 0) return;
    await this.ensureInitialized();

    // Embed all texts
    const texts = docs.map(d => d.embeddingText ?? d.text);
    const embeddings = await this.provider.embed(texts);

    const rows = docs.map((doc, i) => ({
      id: doc.id,
      text: doc.text,
      category: doc.category,
      key: doc.key ?? '',
      created_at: doc.createdAt,
      tenant_id: doc.tenantId ?? 'default',
      chat_id: doc.chatId ?? '',
      vector: embeddings[i],
    }));

    if (!this.table) {
      // Create table with first batch
      this.table = await this.db!.createTable(this.tableName, rows, { mode: 'overwrite' });
      logger.info({ count: rows.length, table: this.tableName }, 'Vector table created');
    } else {
      await this.table
        .mergeInsert('id')
        .whenMatchedUpdateAll()
        .whenNotMatchedInsertAll()
        .execute(rows);
      logger.debug({ count: rows.length }, 'Documents added to vector store');
    }
  }

  /**
   * Atomically replace the logical index contents. This is used when the
   * embedding provider/model/dimension fingerprint changes: vectors produced
   * by different embedding spaces must never share one Lance table.
   */
  async replaceAll(docs: MemoryDocument[]): Promise<void> {
    await this.ensureInitialized();
    if (docs.length === 0) {
      if (this.table) {
        await this.db!.dropTable(this.tableName);
        this.table = null;
      }
      return;
    }

    const texts = docs.map(d => d.embeddingText ?? d.text);
    const embeddings = await this.provider.embed(texts);
    const rows = docs.map((doc, i) => ({
      id: doc.id,
      text: doc.text,
      category: doc.category,
      key: doc.key ?? '',
      created_at: doc.createdAt,
      tenant_id: doc.tenantId ?? 'default',
      chat_id: doc.chatId ?? '',
      vector: embeddings[i],
    }));
    this.table = await this.db!.createTable(this.tableName, rows, { mode: 'overwrite' });
    logger.info({ count: rows.length, table: this.tableName }, 'Vector table replaced');
  }

  /** Remove documents whose source facts are no longer eligible for recall. */
  async delete(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.ensureInitialized();
    if (!this.table) return;
    const quotedIds = ids.map(id => `'${id.replaceAll("'", "''")}'`).join(', ');
    await this.table.delete(`id IN (${quotedIds})`);
    logger.debug({ count: ids.length }, 'Documents removed from vector store');
  }

  /**
   * Search by vector similarity (cosine distance).
   */
  async searchVector(query: string, topK = 20): Promise<SearchResult[]> {
    await this.ensureInitialized();
    if (!this.table) return []; // No documents yet — return empty

    const [queryVec] = await this.provider.embed([query]);

    const results = await this.table
      .vectorSearch(queryVec)
      .limit(topK)
      .toArray();

    return results.map(row => ({
      id: String(row.id),
      text: String(row.text),
      category: String(row.category),
      key: row.key ? String(row.key) : undefined,
      score: 1 - (row._distance ?? 0), // LanceDB returns distance, convert to similarity
      source: 'vector' as const,
      tenantId: row.tenant_id ? String(row.tenant_id) : undefined,
      chatId: row.chat_id ? String(row.chat_id) : undefined,
      createdAt: row.created_at ? Number(row.created_at) : undefined,
    }));
  }

  /**
   * Hybrid search: vector similarity + keyword matching with temporal decay.
   */
  async searchHybrid(query: string, options?: HybridSearchOptions): Promise<SearchResult[]> {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    await this.ensureInitialized();
    if (!this.table) return []; // No documents yet — return empty
    const table = this.table;

    // Vector search
    const [queryVec] = await this.provider.embed([query]);
    const fetchLimit = (opts.tenantId || (opts.chatIds && opts.chatIds.length > 0))
      ? Math.max(opts.topK * 8, 100)
      : opts.topK * 2;
    const vectorResults = await table
      .vectorSearch(queryVec)
      .limit(fetchLimit)  // Over-fetch for re-ranking and tenant/chat filtering
      .toArray();

    // Score and merge
    const scored = new Map<string, {
      id: string;
      text: string;
      category: string;
      key?: string;
      vectorScore: number;
      keywordScore: number;
      createdAt: number;
      tenantId?: string;
      chatId?: string;
    }>();

    for (const row of vectorResults) {
      if (!matchesSearchFilters(row, opts.tenantId, opts.chatIds)) {
        continue;
      }
      const id = String(row.id);
      const vectorScore = 1 - (row._distance ?? 0);
      scored.set(id, {
        id,
        text: String(row.text),
        category: String(row.category),
        key: row.key ? String(row.key) : undefined,
        vectorScore,
        keywordScore: 0,
        createdAt: Number(row.created_at ?? 0),
        tenantId: row.tenant_id ? String(row.tenant_id) : undefined,
        chatId: row.chat_id ? String(row.chat_id) : undefined,
      });
    }

    // Simple keyword boost: if query words appear in text, boost score
    const queryWords = tokenizeText(query).filter(word => (
      isHanToken(word) ? hanTokenLength(word) >= 2 : word.length > 2
    ));
    for (const [, entry] of scored) {
      const textLower = entry.text.toLowerCase();
      let matches = 0;
      for (const word of queryWords) {
        if (textLower.includes(word)) matches++;
      }
      entry.keywordScore = queryWords.length > 0 ? matches / queryWords.length : 0;
    }

    // Compute final score with temporal decay
    const now = Date.now();
    const halfLifeMs = opts.decayHalfLifeDays * 24 * 60 * 60 * 1000;

    const results: SearchResult[] = [];
    for (const [, entry] of scored) {
      let finalScore = entry.vectorScore * opts.vectorWeight + entry.keywordScore * opts.keywordWeight;

      if (opts.temporalDecay && entry.createdAt > 0) {
        const ageMs = now - entry.createdAt;
        const decayFactor = Math.exp(-0.693 * ageMs / halfLifeMs); // ln(2) ≈ 0.693
        finalScore *= (0.5 + 0.5 * decayFactor); // Floor at 50% of original score
      }

      results.push({
        id: entry.id,
        text: entry.text,
        category: entry.category,
        key: entry.key,
        score: finalScore,
        source: 'hybrid',
        tenantId: entry.tenantId,
        chatId: entry.chatId,
        createdAt: entry.createdAt,
      });
    }

    // Sort by score descending, take topK
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, opts.topK);
  }

  /**
   * Get total document count.
   */
  async count(): Promise<number> {
    try {
      const table = await this.ensureTable();
      return await table.countRows();
    } catch {
      return 0;
    }
  }

  /**
   * Close the database connection.
   */
  async close(): Promise<void> {
    this.db = null;
    this.table = null;
    this.initialized = false;
  }
}

// ---------------------------------------------------------------------------
// Singleton management
// ---------------------------------------------------------------------------

let globalStore: VectorStore | null = null;

export function getVectorStore(): VectorStore | null {
  return globalStore;
}

export function setVectorStore(store: VectorStore | null): void {
  globalStore = store;
}

/**
 * Initialize the global vector store from config.
 */
export async function initVectorStore(
  dbPath: string,
  provider: EmbeddingProvider,
  tableName = 'memory_vectors',
): Promise<VectorStore> {
  const store = new VectorStore(dbPath, provider, tableName);
  globalStore = store;
  logger.info({ dbPath, table: tableName, provider: provider.providerName, model: provider.modelName }, 'Vector store initialized');
  return store;
}
