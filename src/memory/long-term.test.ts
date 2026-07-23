import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import {
  saveFact,
  getFacts,
  getFactsByUser,
  getAccessibleFacts,
  updateFactValue,
  updateFactStatus,
  deleteAllAccessibleFacts,
  searchSemanticFacts,
  flushMemoryVectorWritesForTests,
  deleteFact,
  recordRecall,
  decayUnusedFacts,
  consolidateEpisodes,
  pruneStale,
  pruneLowSalienceFacts,
} from './long-term.js';
import { getDb } from '../store/db.js';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import { getConfig, loadConfig, updateConfig } from '../config/index.js';
import {
  getMemoryVectorStore,
  resetMemoryEmbeddingProviderForTests,
  setMemoryEmbeddingProviderForTests,
} from './embedding-provider.js';
import type { EmbeddingProvider } from './embeddings.js';

let tmpDir: string;

beforeAll(() => {
  const result = setupTestDb();
  tmpDir = result.tmpDir;
  loadConfig('/nonexistent/mozi.json');
});

beforeEach(() => {
  setMemoryEmbeddingProviderForTests(null);
});

afterEach(async () => {
  await flushMemoryVectorWritesForTests();
  resetMemoryEmbeddingProviderForTests();
});

afterAll(() => {
  teardownTestDb(tmpDir);
});

class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 4;
  readonly providerName = 'fake';
  readonly modelName = 'fake-embed';
  readonly calls: string[][] = [];

  async embed(texts: string[]): Promise<number[][]> {
    this.calls.push(texts);
    return texts.map(() => [1, 0, 0, 0]);
  }
}

describe('memory/long-term — facts', () => {
  it('saves and retrieves a fact', () => {
    saveFact('chat_lt1', 'preference', 'language', 'TypeScript');
    const facts = getFacts('chat_lt1');
    expect(facts).toHaveLength(1);
    expect(facts[0].category).toBe('preference');
    expect(facts[0].key).toBe('language');
    expect(facts[0].value).toBe('TypeScript');
    expect(facts[0].confidence).toBe(1.0);
  });

  it('does not call embeddings below the semantic activation threshold', async () => {
    const originalMoziHome = process.env.MOZI_HOME;
    process.env.MOZI_HOME = tmpDir;
    const provider = new FakeEmbeddingProvider();
    setMemoryEmbeddingProviderForTests(provider);

    try {
      saveFact('chat_vector_write', 'preference', 'language', 'TypeScript', 'unit_test');
      await flushMemoryVectorWritesForTests();
    } finally {
      if (originalMoziHome === undefined) delete process.env.MOZI_HOME;
      else process.env.MOZI_HOME = originalMoziHome;
    }

    expect(provider.calls).toHaveLength(0);
  });

  it('builds the real vector index once the activation threshold is reached', async () => {
    const originalMoziHome = process.env.MOZI_HOME;
    const previousThreshold = getConfig().memory.semantic_activation_threshold;
    process.env.MOZI_HOME = tmpDir;
    updateConfig('memory.semantic_activation_threshold', 1);
    const provider = new FakeEmbeddingProvider();

    try {
      setMemoryEmbeddingProviderForTests(provider, 'vector-active');
      saveFact('chat_vector_active', 'preference', 'language', 'TypeScript', 'unit_test', 'vector-active');
      await flushMemoryVectorWritesForTests();
    } finally {
      updateConfig('memory.semantic_activation_threshold', previousThreshold);
      if (originalMoziHome === undefined) delete process.env.MOZI_HOME;
      else process.env.MOZI_HOME = originalMoziHome;
    }

    expect(provider.calls.flat()).toContain('preference language TypeScript');
  });

  it('removes inactive facts from vectors and restores them on promotion', async () => {
    const originalMoziHome = process.env.MOZI_HOME;
    const previousThreshold = getConfig().memory.semantic_activation_threshold;
    process.env.MOZI_HOME = tmpDir;
    updateConfig('memory.semantic_activation_threshold', 1);
    const provider = new FakeEmbeddingProvider();
    const tenantId = 'vector-lifecycle';

    try {
      setMemoryEmbeddingProviderForTests(provider, tenantId);
      saveFact('chat_vector_lifecycle', 'fact', 'runtime', 'Fastify', 'unit_test', tenantId);
      await flushMemoryVectorWritesForTests();
      const fact = getFacts('chat_vector_lifecycle', undefined, tenantId)[0];
      const store = await getMemoryVectorStore(tenantId);
      expect(await store?.count()).toBe(1);

      expect(updateFactStatus(fact.id, 'pending_review', tenantId)?.status).toBe('pending_review');
      await flushMemoryVectorWritesForTests();
      expect(await store?.count()).toBe(0);

      expect(updateFactStatus(fact.id, 'active', tenantId)?.status).toBe('active');
      await flushMemoryVectorWritesForTests();
      expect(await store?.count()).toBe(1);
    } finally {
      updateConfig('memory.semantic_activation_threshold', previousThreshold);
      if (originalMoziHome === undefined) delete process.env.MOZI_HOME;
      else process.env.MOZI_HOME = originalMoziHome;
    }
  });

  it('upserts on duplicate (tenant_id+chat_id+category+key)', () => {
    saveFact('chat_lt2', 'fact', 'color', 'blue');
    saveFact('chat_lt2', 'fact', 'color', 'red');
    const facts = getFacts('chat_lt2', 'fact');
    expect(facts).toHaveLength(1);
    expect(facts[0].value).toBe('red');
  });

  it('re-saving a fact with lower salience decreases the score (EMA, not MAX)', () => {
    // Save with high salience
    saveFact('chat_ema', 'fact', 'ema_key', 'v1', undefined, 'default', undefined, 0.9);
    const before = getFacts('chat_ema', 'fact');
    expect(before).toHaveLength(1);
    const highScore = before[0].salience_score;
    expect(highScore).toBeCloseTo(0.9, 1);

    // Re-save with much lower salience
    saveFact('chat_ema', 'fact', 'ema_key', 'v2', undefined, 'default', undefined, 0.1);
    const after = getFacts('chat_ema', 'fact');
    expect(after).toHaveLength(1);
    // EMA: 0.9 * 0.7 + 0.1 * 0.3 = 0.63 + 0.03 = 0.66
    expect(after[0].salience_score).toBeLessThan(highScore);
    expect(after[0].salience_score).toBeCloseTo(0.66, 1);
  });

  it('filters by category', () => {
    saveFact('chat_lt3', 'preference', 'editor', 'vim');
    saveFact('chat_lt3', 'decision', 'framework', 'fastify');
    saveFact('chat_lt3', 'lesson', 'testing', 'always test edge cases');

    const prefs = getFacts('chat_lt3', 'preference');
    expect(prefs).toHaveLength(1);
    expect(prefs[0].key).toBe('editor');

    const decisions = getFacts('chat_lt3', 'decision');
    expect(decisions).toHaveLength(1);
    expect(decisions[0].key).toBe('framework');
  });

  it('returns all facts when no category filter', () => {
    saveFact('chat_lt4', 'preference', 'a', '1');
    saveFact('chat_lt4', 'fact', 'b', '2');
    saveFact('chat_lt4', 'decision', 'c', '3');
    const all = getFacts('chat_lt4');
    expect(all).toHaveLength(3);
  });

  it('deletes a specific fact', () => {
    saveFact('chat_lt5', 'fact', 'temp', 'value');
    deleteFact('chat_lt5', 'fact', 'temp');
    const facts = getFacts('chat_lt5');
    expect(facts).toHaveLength(0);
  });

  it('delete does not affect other facts', () => {
    saveFact('chat_lt6', 'fact', 'keep', 'yes');
    saveFact('chat_lt6', 'fact', 'remove', 'no');
    deleteFact('chat_lt6', 'fact', 'remove');
    const facts = getFacts('chat_lt6');
    expect(facts).toHaveLength(1);
    expect(facts[0].key).toBe('keep');
  });

  it('isolates facts by chat_id', () => {
    saveFact('chat_iso_a', 'fact', 'x', '1');
    saveFact('chat_iso_b', 'fact', 'x', '2');
    const a = getFacts('chat_iso_a');
    const b = getFacts('chat_iso_b');
    expect(a).toHaveLength(1);
    expect(a[0].value).toBe('1');
    expect(b).toHaveLength(1);
    expect(b[0].value).toBe('2');
  });

  it('isolates facts by tenant_id', () => {
    saveFact('chat_tenant', 'fact', 'k', 'v1', undefined, 'tenant_x');
    saveFact('chat_tenant', 'fact', 'k', 'v2', undefined, 'tenant_y');
    const x = getFacts('chat_tenant', undefined, 'tenant_x');
    const y = getFacts('chat_tenant', undefined, 'tenant_y');
    expect(x).toHaveLength(1);
    expect(x[0].value).toBe('v1');
    expect(y).toHaveLength(1);
    expect(y[0].value).toBe('v2');
  });

  it('stores source when provided', () => {
    saveFact('chat_src', 'lesson', 'tip', 'use strict mode', 'user_input');
    const facts = getFacts('chat_src');
    expect(facts[0].source).toBe('user_input');
  });

  it('assigns high salience to correction memories', () => {
    saveFact('chat_salience', 'fact', 'correction_deadline', 'Tuesday not Monday', 'auto_extract_correction');
    const facts = getFacts('chat_salience');
    expect(facts[0].salience_score).toBeGreaterThanOrEqual(0.9);
  });

  it('returns empty array for unknown chat', () => {
    const facts = getFacts('nonexistent');
    expect(facts).toEqual([]);
  });

  it('respects configurable write_policy=first_write_wins', () => {
    updateConfig('memory.write_policy', 'first_write_wins');
    saveFact('chat_policy', 'fact', 'language', 'TypeScript');
    saveFact('chat_policy', 'fact', 'language', 'Rust');
    const facts = getFacts('chat_policy', 'fact');
    expect(facts).toHaveLength(1);
    expect(facts[0].value).toBe('TypeScript');
    updateConfig('memory.write_policy', 'upsert');
  });

  it('saves userId and retrieves via getFactsByUser', () => {
    saveFact('chat_uid1', 'preference', 'lang', 'TypeScript', undefined, 'default', 'user_abc');
    saveFact('chat_uid2', 'fact', 'team', 'backend', undefined, 'default', 'user_abc');

    // getFactsByUser retrieves across chat sessions
    const userFacts = getFactsByUser('user_abc');
    expect(userFacts).toHaveLength(2);
    expect(userFacts.some(f => f.key === 'lang')).toBe(true);
    expect(userFacts.some(f => f.key === 'team')).toBe(true);
  });

  it('getFactsByUser filters by category', () => {
    saveFact('chat_uid3', 'preference', 'theme', 'dark', undefined, 'default', 'user_filter');
    saveFact('chat_uid3', 'decision', 'db', 'sqlite', undefined, 'default', 'user_filter');

    const prefs = getFactsByUser('user_filter', 'default', 'preference');
    expect(prefs).toHaveLength(1);
    expect(prefs[0].key).toBe('theme');
  });

  it('getFactsByUser isolates by tenantId', () => {
    saveFact('chat_uid4', 'fact', 'k', 'v1', undefined, 'tenant_u1', 'user_iso');
    saveFact('chat_uid4', 'fact', 'k', 'v2', undefined, 'tenant_u2', 'user_iso');

    const t1 = getFactsByUser('user_iso', 'tenant_u1');
    const t2 = getFactsByUser('user_iso', 'tenant_u2');
    expect(t1).toHaveLength(1);
    expect(t1[0].value).toBe('v1');
    expect(t2).toHaveLength(1);
    expect(t2[0].value).toBe('v2');
  });
});

describe('recall tracking + decay + consolidation', () => {
  it('recordRecall increments count and sets timestamp', () => {
    saveFact('chat_recall1', 'fact', 'tool', 'vitest');
    const before = getFacts('chat_recall1');
    expect(before[0].recall_count).toBe(0);
    expect(before[0].last_recalled_at).toBeNull();
    const beforeSalience = before[0].salience_score;

    recordRecall([before[0].id]);
    const after = getFacts('chat_recall1');
    expect(after[0].recall_count).toBe(1);
    expect(after[0].last_recalled_at).not.toBeNull();
    expect(after[0].salience_score).toBe(beforeSalience);

    // Second recall
    recordRecall([after[0].id]);
    const after2 = getFacts('chat_recall1');
    expect(after2[0].recall_count).toBe(2);
  });

  it('recordRecall with empty array is no-op', () => {
    // Should not throw
    recordRecall([]);
  });

  it('decayUnusedFacts halves confidence and respects 0.1 floor', () => {
    const tenantId = 'decay_test';
    saveFact('chat_decay1', 'fact', 'old_fact', 'value', undefined, tenantId);
    // Set updated_at to 60 days ago so it qualifies for decay
    const db = getDb();
    db.prepare(`
      UPDATE memory_facts SET updated_at = datetime('now', '-60 days')
      WHERE tenant_id = ? AND chat_id = 'chat_decay1' AND key = 'old_fact'
    `).run(tenantId);

    const changed = decayUnusedFacts(tenantId, 30);
    expect(changed).toBe(1);
    const facts = getFacts('chat_decay1', undefined, tenantId);
    expect(facts[0].confidence).toBe(0.5);

    // Decay again — 0.5 * 0.5 = 0.25
    const changed2 = decayUnusedFacts(tenantId, 0);
    expect(changed2).toBe(1);
    const facts2 = getFacts('chat_decay1', undefined, tenantId);
    expect(facts2[0].confidence).toBe(0.25);

    // Keep decaying until floor
    decayUnusedFacts(tenantId, 0);
    decayUnusedFacts(tenantId, 0);
    decayUnusedFacts(tenantId, 0);
    const factsFloor = getFacts('chat_decay1', undefined, tenantId);
    expect(factsFloor[0].confidence).toBeGreaterThanOrEqual(0.1);
  });

  it('decayUnusedFacts skips recently recalled facts', () => {
    const tenantId = 'decay_skip_test';
    saveFact('chat_decay2', 'fact', 'recalled_fact', 'value', undefined, tenantId);
    const facts = getFacts('chat_decay2', undefined, tenantId);
    // Mark as recently recalled
    recordRecall([facts[0].id]);

    const changed = decayUnusedFacts(tenantId, 30);
    expect(changed).toBe(0);
    const after = getFacts('chat_decay2', undefined, tenantId);
    expect(after[0].confidence).toBe(1.0);
  });

  it('consolidateEpisodes creates semantic facts from cross-chat patterns', () => {
    const tenantId = 'consolidate_test';
    // Same category+key across 3 chats
    saveFact('chat_c1', 'preference', 'lang', 'TypeScript', undefined, tenantId);
    saveFact('chat_c2', 'preference', 'lang', 'TypeScript', undefined, tenantId);
    saveFact('chat_c3', 'preference', 'lang', 'TypeScript', undefined, tenantId);

    const count = consolidateEpisodes(tenantId, 3);
    expect(count).toBe(1);

    const semanticFacts = getFacts('__semantic__', undefined, tenantId);
    expect(semanticFacts.length).toBeGreaterThanOrEqual(1);
    const langFact = semanticFacts.find(f => f.key === 'lang');
    expect(langFact).toBeDefined();
    expect(langFact!.source).toBe('consolidation');
  });

  it('consolidateEpisodes respects minOccurrences threshold', () => {
    const tenantId = 'consolidate_threshold';
    // Only 2 chats — below threshold of 3
    saveFact('chat_t1', 'fact', 'team', 'backend', undefined, tenantId);
    saveFact('chat_t2', 'fact', 'team', 'backend', undefined, tenantId);

    const count = consolidateEpisodes(tenantId, 3);
    expect(count).toBe(0);
  });

  it('consolidateEpisodes does not merge unrelated Chinese facts with distinct keys', () => {
    const tenantId = 'consolidate_chinese_distinct_keys';
    saveFact('chat_cn_1', 'fact', '用户喜欢喝乌龙茶', '用户喜欢喝乌龙茶', undefined, tenantId);
    saveFact('chat_cn_2', 'fact', '用户住在上海', '用户住在上海', undefined, tenantId);
    saveFact('chat_cn_3', 'fact', '用户使用pnpm', '用户使用 pnpm', undefined, tenantId);

    const count = consolidateEpisodes(tenantId, 2);
    expect(count).toBe(0);
    expect(getFacts('__semantic__', undefined, tenantId)).toHaveLength(0);
  });

  it('pruneStale removes low-confidence old facts', () => {
    const tenantId = 'prune_test';
    saveFact('chat_prune', 'fact', 'stale', 'old value', undefined, tenantId);
    // Set low confidence and old date
    const db = getDb();
    db.prepare(`
      UPDATE memory_facts SET confidence = 0.1, updated_at = datetime('now', '-90 days')
      WHERE tenant_id = ? AND chat_id = 'chat_prune' AND key = 'stale'
    `).run(tenantId);

    const pruned = pruneStale(tenantId, 0.1, 60);
    expect(pruned).toBe(1);
    const remaining = getFacts('chat_prune', undefined, tenantId);
    expect(remaining).toHaveLength(0);
  });

  it('pruneStale preserves high-confidence facts', () => {
    const tenantId = 'prune_preserve';
    saveFact('chat_prune2', 'fact', 'important', 'still useful', undefined, tenantId);
    // Old but high confidence
    const db = getDb();
    db.prepare(`
      UPDATE memory_facts SET updated_at = datetime('now', '-90 days')
      WHERE tenant_id = ? AND chat_id = 'chat_prune2' AND key = 'important'
    `).run(tenantId);

    const pruned = pruneStale(tenantId, 0.1, 60);
    expect(pruned).toBe(0);
    const remaining = getFacts('chat_prune2', undefined, tenantId);
    expect(remaining).toHaveLength(1);
  });

  it('pruneLowSalienceFacts deletes low-salience episodic facts and keeps semantic consolidation', () => {
    const tenantId = 'prune_salience';
    saveFact('chat_ps_1', 'fact', 'deprecated_hint', 'old noisy value', undefined, tenantId, undefined, 0.05);
    saveFact('chat_ps_2', 'fact', 'deprecated_hint', 'old noisy value 2', undefined, tenantId, undefined, 0.08);
    const db = getDb();
    db.prepare(`
      UPDATE memory_facts
      SET updated_at = datetime('now', '-45 days')
      WHERE tenant_id = ? AND key = 'deprecated_hint' AND chat_id != '__semantic__'
    `).run(tenantId);

    const pruned = pruneLowSalienceFacts(tenantId, 0.1, 30);
    expect(pruned).toBe(2);

    const episodicRemaining = getFacts('chat_ps_1', undefined, tenantId);
    expect(episodicRemaining).toHaveLength(0);
    const semantic = getFacts('__semantic__', undefined, tenantId);
    const consolidated = semantic.find(f => f.key === 'deprecated_hint');
    expect(consolidated).toBeDefined();
    expect(consolidated?.source).toBe('forgetting_consolidation');
  });
});

describe('memory/long-term — semantic retrieval', () => {
  it('returns top-k local lexical hits with source and timestamp grounding', () => {
    saveFact('chat_sem_1', 'fact', 'vehicle', 'car', 'user_note');
    saveFact('chat_sem_1', 'fact', 'framework', 'fastify', 'project_doc');
    saveFact('chat_sem_1', 'fact', 'testing', 'vitest', 'project_doc');

    const hits = searchSemanticFacts('chat_sem_1', 'car', 'default', 2, 0.05);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].fact.key).toBe('vehicle');
    expect(hits[0].source).toBeTruthy();
    expect(hits[0].timestamp).toBeTruthy();
    expect(hits.length).toBeLessThanOrEqual(2);
  });

  it('preserves FTS5 BM25 relevance when the final hit list is sorted', () => {
    const tenantId = 'semantic_latin_bm25';
    const chatId = 'semantic_latin_bm25_chat';
    saveFact(chatId, 'fact', 'weak_match', 'report', 'unit_test', tenantId);
    saveFact(chatId, 'fact', 'report_report_report', 'report report report', 'unit_test', tenantId);
    const strong = getFacts(chatId, undefined, tenantId).find(fact => fact.key === 'report_report_report');
    expect(strong).toBeDefined();
    getDb().prepare("UPDATE memory_facts SET updated_at = datetime('now', '-30 days') WHERE id = ?")
      .run(strong!.id);

    const hits = searchSemanticFacts(chatId, 'report', tenantId, 2, 0);

    expect(hits.map(hit => hit.fact.key)).toEqual(['report_report_report', 'weak_match']);
  });

  it('recalls chat-stored facts when scoped to matching userId', () => {
    const tenantId = 'semantic_user_scope';
    const chatId = 'semantic_user_scope_chat';
    const userId = 'semantic_user_scope_user';
    saveFact(chatId, 'fact', '城市', '用户住在上海', 'unit_test', tenantId, userId);

    const hits = searchSemanticFacts(
      userId,
      '上海',
      tenantId,
      5,
      0,
      { userId, accessibleChatIds: [chatId, userId, '__semantic__'] },
    );

    expect(hits.some(hit => (
      hit.fact.chat_id === chatId
      && hit.fact.user_id === userId
      && hit.fact.value === '用户住在上海'
    ))).toBe(true);
  });

  it('ranks a strong Chinese match before newer single-term decoys prior to topK', () => {
    const tenantId = 'semantic_cjk_topk';
    const chatId = 'semantic_cjk_topk_chat';
    saveFact(chatId, 'preference', '报告格式', '偏好简洁的报告格式', 'unit_test', tenantId);
    const target = getFacts(chatId, undefined, tenantId).find(fact => fact.key === '报告格式');
    expect(target).toBeDefined();
    getDb().prepare("UPDATE memory_facts SET updated_at = datetime('now', '-30 days') WHERE id = ?")
      .run(target!.id);
    for (let index = 0; index < 8; index++) {
      saveFact(chatId, 'fact', `报告诱饵${index}`, `只提到报告 ${index}`, 'unit_test', tenantId);
    }

    const hits = searchSemanticFacts(chatId, '我的报告格式偏好', tenantId, 2, 0);

    expect(hits[0]?.fact.id).toBe(target!.id);
    expect(hits.map(hit => hit.fact.key)).not.toContain('报告诱饵7');
  });

  it('supports two-character Chinese queries and rejects single-Han noise', () => {
    const tenantId = 'semantic_cjk_short';
    const chatId = 'semantic_cjk_short_chat';
    saveFact(chatId, 'fact', '报告', '季度报告已完成', 'unit_test', tenantId);

    expect(searchSemanticFacts(chatId, '报告', tenantId, 5, 0))
      .toEqual(expect.arrayContaining([expect.objectContaining({ fact: expect.objectContaining({ key: '报告' }) })]));
    expect(searchSemanticFacts(chatId, '报', tenantId, 5, 0)).toEqual([]);
  });

  it('recalls Ext-A and non-BMP two-code-point Han terms with the runtime segmenter', () => {
    const tenantId = 'semantic_cjk_unicode_planes';
    const chatId = 'semantic_cjk_unicode_planes_chat';
    saveFact(chatId, 'fact', '㐀报', '㐀报已确认', 'unit_test', tenantId);
    saveFact(chatId, 'fact', '\u{20000}报', '\u{20000}报已确认', 'unit_test', tenantId);

    expect(searchSemanticFacts(chatId, '㐀报', tenantId, 5, 0).map(hit => hit.fact.key)).toContain('㐀报');
    expect(searchSemanticFacts(chatId, '\u{20000}报', tenantId, 5, 0).map(hit => hit.fact.key)).toContain('\u{20000}报');
  });

  it('merges mixed ASCII and Chinese retrieval and de-duplicates facts matching both branches', () => {
    const tenantId = 'semantic_mixed';
    const chatId = 'semantic_mixed_chat';
    saveFact(chatId, 'fact', 'report_only', 'English report workflow', 'unit_test', tenantId);
    saveFact(chatId, 'fact', '报告流程', '中文报告流程', 'unit_test', tenantId);
    saveFact(chatId, 'fact', 'report_报告', 'report 报告', 'unit_test', tenantId);

    const hits = searchSemanticFacts(chatId, 'report 报告', tenantId, 10, 0);
    const keys = hits.map(hit => hit.fact.key);

    expect(keys).toContain('report_only');
    expect(keys).toContain('报告流程');
    expect(keys.filter(key => key === 'report_报告')).toHaveLength(1);
  });

  it('keeps stronger Latin BM25 hits ahead of weaker Latin hits in a mixed query', () => {
    const tenantId = 'semantic_mixed_bm25';
    const chatId = 'semantic_mixed_bm25_chat';
    saveFact(chatId, 'fact', 'weak_report', 'report', 'unit_test', tenantId);
    saveFact(chatId, 'fact', 'report_report_report', 'report report report', 'unit_test', tenantId);
    saveFact(chatId, 'fact', '报告', '中文报告', 'unit_test', tenantId);

    const keys = searchSemanticFacts(chatId, 'report 报告', tenantId, 10, 0)
      .map(hit => hit.fact.key);

    expect(keys.indexOf('report_report_report')).toBeLessThan(keys.indexOf('weak_report'));
    expect(keys).toContain('报告');
  });

  it('keeps tenant, status, user, and chat access filters aligned in the CJK CTE', () => {
    const tenantId = 'semantic_cjk_scope';
    const userId = 'semantic_cjk_scope_user';
    const allowedChat = 'semantic_cjk_scope_allowed';
    const blockedChat = 'semantic_cjk_scope_blocked';
    saveFact(allowedChat, 'fact', '报告格式', '报告格式已确认', 'unit_test', tenantId, userId);
    saveFact(blockedChat, 'fact', '报告格式_other_user', '报告格式不应泄露', 'unit_test', tenantId, 'other-user');
    saveFact(blockedChat, 'fact', '报告格式_null_user', '报告格式不在可访问会话', 'unit_test', tenantId);
    saveFact(allowedChat, 'fact', '报告格式_pending', '报告格式待审核', 'unit_test', tenantId, userId);
    const pending = getFacts(allowedChat, undefined, tenantId).find(fact => fact.key === '报告格式_pending');
    expect(pending).toBeDefined();
    updateFactStatus(pending!.id, 'pending_review', tenantId);
    saveFact(allowedChat, 'fact', '报告格式_other_tenant', '报告格式其他租户', 'unit_test', 'other-tenant', userId);

    const hits = searchSemanticFacts(
      userId,
      '报告格式',
      tenantId,
      10,
      0,
      { userId, accessibleChatIds: [allowedChat] },
    );

    expect(hits.map(hit => hit.fact.key)).toEqual(['报告格式']);
  });
});

describe('memory/long-term — browser access + edit', () => {
  it('getAccessibleFacts surfaces facts across chats without pinning a single chat_id', () => {
    // Facts stored under real session chat_ids (the empty-browser bug: a
    // chat_id='global' query would miss all of these).
    saveFact('sess_A', 'preference', 'tone', 'concise', 'auto', 'default', 'user_gaf');
    saveFact('sess_B', 'fact', 'city', 'Shanghai', 'auto', 'default', 'user_gaf');
    const scope = { userId: 'user_gaf', accessibleChatIds: ['sess_A', 'sess_B'] };

    const all = getAccessibleFacts('default', scope);
    const values = all.map((f) => f.value);
    expect(values).toContain('concise');
    expect(values).toContain('Shanghai');
  });

  it('getAccessibleFacts filters by category and excludes other users', () => {
    saveFact('sess_C', 'preference', 'gaf_pref', 'dark mode', 'auto', 'default', 'user_gaf2');
    saveFact('sess_C', 'fact', 'gaf_fact', 'lives in Beijing', 'auto', 'default', 'user_gaf2');
    saveFact('sess_D', 'preference', 'other_pref', 'light mode', 'auto', 'default', 'user_other');
    const scope = { userId: 'user_gaf2', accessibleChatIds: ['sess_C'] };

    const prefs = getAccessibleFacts('default', scope, 'preference');
    expect(prefs.map((f) => f.value)).toContain('dark mode');
    expect(prefs.every((f) => f.category === 'preference')).toBe(true);
    // Another user's fact under a non-accessible chat must not leak.
    expect(prefs.map((f) => f.value)).not.toContain('light mode');
  });

  it('updateFactValue edits an owned fact and rejects a non-accessible one', () => {
    saveFact('sess_E', 'fact', 'ufv_key', 'old value', 'auto', 'default', 'user_ufv');
    const fact = getFactsByUser('user_ufv', 'default').find((f) => f.key === 'ufv_key');
    expect(fact).toBeDefined();
    const scope = { userId: 'user_ufv', accessibleChatIds: ['sess_E'] };

    const updated = updateFactValue(fact!.id, 'new value', 'default', scope);
    expect(updated?.value).toBe('new value');
    expect(updated?.source).toBe('user_edit');

    // A different user cannot edit it.
    const stranger = { userId: 'someone_else', accessibleChatIds: ['sess_zzz'] };
    expect(updateFactValue(fact!.id, 'hijacked', 'default', stranger)).toBeNull();
    const reread = getFactsByUser('user_ufv', 'default').find((f) => f.id === fact!.id);
    expect(reread?.value).toBe('new value');
  });

  it('deleteAllAccessibleFacts clears only the caller-accessible facts', () => {
    saveFact('sess_clear', 'fact', 'clr_1', 'mine A', 'auto', 'default', 'user_clear');
    saveFact('sess_clear', 'fact', 'clr_2', 'mine B', 'auto', 'default', 'user_clear');
    saveFact('sess_other', 'fact', 'clr_other', 'not mine', 'auto', 'default', 'user_keep');
    const scope = { userId: 'user_clear', accessibleChatIds: ['sess_clear'] };

    const deleted = deleteAllAccessibleFacts('default', scope);
    expect(deleted).toBeGreaterThanOrEqual(2);
    expect(getAccessibleFacts('default', scope)).toHaveLength(0);
    // The other user's fact survives.
    expect(getFactsByUser('user_keep', 'default').some((f) => f.value === 'not mine')).toBe(true);
  });
});
