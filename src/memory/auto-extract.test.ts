import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { extractMemories, isSubstantiallySimilar } from './auto-extract.js';
import { getFacts, getFactsByUser, saveFact } from './long-term.js';
import { projectChatId } from './project-context.js';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import type { LLMClient, ChatResponse, ChatMessage, ChatOptions, StreamChunk } from '../core/llm.js';
import {
  resetMemoryEmbeddingProviderForTests,
  setMemoryEmbeddingProviderForTests,
} from './embedding-provider.js';

let tmpDir: string;

beforeAll(() => {
  const result = setupTestDb();
  tmpDir = result.tmpDir;
});

beforeEach(() => {
  setMemoryEmbeddingProviderForTests(null);
});

afterEach(() => {
  resetMemoryEmbeddingProviderForTests();
});

afterAll(() => {
  teardownTestDb(tmpDir);
});

function makeMockClient(content: string): LLMClient {
  return {
    provider: 'mock',
    chat: vi.fn().mockResolvedValue({
      content,
      usage: { input_tokens: 8, output_tokens: 12 },
      model: 'mock-model',
      stop_reason: 'end',
    } satisfies ChatResponse),
    async *chatStream(_msgs: ChatMessage[], _opts?: ChatOptions): AsyncGenerator<StreamChunk> {
      yield {
        type: 'done',
        response: {
          content,
          usage: { input_tokens: 8, output_tokens: 12 },
          model: 'mock-model',
          stop_reason: 'end',
        },
      };
    },
  };
}

describe('memory/auto-extract', () => {
  it('extracts known JSON and stores each category as long-term facts', async () => {
    const chatId = 'auto_extract_known_json';
    const client = makeMockClient(JSON.stringify({
      preferences: [{ key: 'editor', value: 'vim' }],
      facts: [{ key: 'timezone', value: 'PST' }],
      decisions: [{ key: 'framework', value: 'fastify' }],
      corrections: [{ key: 'deadline', value: 'Tuesday, not Monday' }],
    }));

    await extractMemories(
      'I use vim and prefer short answers.',
      'Noted. We will use fastify and PST timezone.',
      client,
      chatId,
    );

    const chatCall = (client.chat as ReturnType<typeof vi.fn>).mock.calls[0];
    const promptMessages = chatCall[0] as ChatMessage[];
    const options = chatCall[1] as ChatOptions;

    expect(promptMessages[0].role).toBe('system');
    expect(promptMessages[0].content).toContain('durable long-term memory');
    expect(promptMessages[0].content).toContain('STRICT JSON');
    // model should NOT be hardcoded — client uses its configured default
    expect(options.model).toBeUndefined();
    expect(options.max_tokens).toBe(400);

    const facts = getFacts(chatId);
    expect(facts).toHaveLength(4);

    expect(facts.find(f => f.category === 'preference' && f.key === 'editor' && f.value === 'vim')).toBeDefined();
    expect(facts.find(f => f.category === 'fact' && f.key === 'timezone' && f.value === 'PST')).toBeDefined();
    expect(facts.find(f => f.category === 'decision' && f.key === 'framework' && f.value === 'fastify')).toBeDefined();
    const correction = facts.find(f => f.category === 'fact' && f.key === 'deadline' && f.value.includes('Tuesday'));
    expect(correction).toBeDefined();
    expect(correction!.salience_score).toBeGreaterThanOrEqual(0.9);
  });

  it('ignores invalid JSON payloads safely', async () => {
    const chatId = 'auto_extract_invalid_json';
    const client = makeMockClient('this is not valid json');

    await expect(
      extractMemories('user text', 'assistant text', client, chatId),
    ).resolves.toEqual({ mutations: [] });

    expect(getFacts(chatId)).toEqual([]);
  });

  it('skips writing when existing fact has substantially similar value', async () => {
    const chatId = 'auto_extract_dedup';
    // Pre-populate a fact
    const { saveFact } = await import('./long-term.js');
    saveFact(chatId, 'preference', 'editor', 'I prefer using vim editor');

    // Now extract a near-identical value
    const client = makeMockClient(JSON.stringify({
      preferences: [{ key: 'editor', value: 'I prefer using vim editor mostly' }],
      facts: [],
      decisions: [],
      corrections: [],
    }));

    await extractMemories('msg', 'resp', client, chatId);

    // Value should remain unchanged (dedup prevented overwrite)
    const facts = getFacts(chatId, 'preference');
    const editorFact = facts.find(f => f.key === 'editor');
    expect(editorFact!.value).toBe('I prefer using vim editor');
  });

  it('stores consecutive Chinese facts with different non-empty keys instead of overwriting', async () => {
    const chatId = 'auto_extract_chinese_keys';
    const firstClient = makeMockClient(JSON.stringify({
      preferences: [],
      facts: ['用户喜欢喝乌龙茶'],
      decisions: [],
      corrections: [],
    }));
    const secondClient = makeMockClient(JSON.stringify({
      preferences: [],
      facts: ['用户住在上海'],
      decisions: [],
      corrections: [],
    }));

    await extractMemories('我喜欢喝乌龙茶', '已记录。', firstClient, chatId);
    await extractMemories('我住在上海', '已记录。', secondClient, chatId);

    const facts = getFacts(chatId, 'fact');
    expect(facts).toHaveLength(2);
    expect(facts.map(f => f.value).sort()).toEqual(['用户住在上海', '用户喜欢喝乌龙茶'].sort());

    const keys = facts.map(f => f.key);
    expect(keys.every(key => key.length > 0)).toBe(true);
    expect(new Set(keys).size).toBe(2);
    expect(keys).not.toContain('fact_1');
  });

  it('persists userId from extraction and retrieves facts by user', async () => {
    const chatId = 'auto_extract_user_id_chat';
    const tenantId = 'auto_extract_user_id_tenant';
    const userId = 'auto_extract_user_123';
    const client = makeMockClient(JSON.stringify({
      preferences: [],
      facts: [{ key: '城市', value: '用户住在上海' }],
      decisions: [],
      corrections: [],
    }));

    await extractMemories('我住在上海', '已记录。', client, chatId, tenantId, userId);

    const chatFacts = getFacts(chatId, 'fact', tenantId);
    expect(chatFacts).toHaveLength(1);
    expect(chatFacts[0].user_id).toBe(userId);

    const userFacts = getFactsByUser(userId, tenantId);
    expect(userFacts).toHaveLength(1);
    expect(userFacts[0].chat_id).toBe(chatId);
    expect(userFacts[0].value).toBe('用户住在上海');
  });

  it('uses an existing memory id to reinforce a paraphrase instead of adding a duplicate', async () => {
    const chatId = 'auto_extract_semantic_dedup';
    const tenantId = 'auto_extract_semantic_tenant';
    const userId = 'auto_extract_semantic_user';
    const { applyMemoryMutation } = await import('./mutations.js');
    const existing = applyMemoryMutation({
      chatId,
      tenantId,
      userId,
      turnId: 'turn-original',
      category: 'preference',
      key: 'data_first',
      value: '所有任务都必须先查数据，再下结论。',
      source: 'tool',
    });
    const client = makeMockClient(JSON.stringify({
      preferences: [{
        key: 'verification_first',
        value: '用户再次强调不能猜测，必须先进行数据验证。',
        action: 'reinforce',
        target_id: existing.fact.id,
      }],
      facts: [],
      decisions: [],
      corrections: [],
    }));

    const result = await extractMemories(
      '还是那句话，不要猜，先验证数据。',
      '明白。',
      client,
      chatId,
      tenantId,
      userId,
      'turn-repeat',
    );

    expect(result.mutations).toHaveLength(1);
    expect(result.mutations[0].action).toBe('REINFORCE');
    expect(result.mutations[0].fact.id).toBe(existing.fact.id);
    expect(getFactsByUser(userId, tenantId)).toHaveLength(1);
    const prompt = ((client.chat as ReturnType<typeof vi.fn>).mock.calls[0][0] as ChatMessage[])[1].content;
    expect(prompt).toContain(`\"id\":${existing.fact.id}`);
  });

  it('cannot target or expose project facts through ordinary auto-extraction', async () => {
    const chatId = 'auto_extract_project_boundary_chat';
    const tenantId = 'auto_extract_project_boundary_tenant';
    const userId = 'auto_extract_project_boundary_user';
    saveFact(
      projectChatId(userId),
      'fact',
      'runtime',
      'The project uses Fastify.',
      'project_user_assertion',
      tenantId,
      userId,
      undefined,
      'active',
      'user',
    );
    const projectFact = getFacts(projectChatId(userId), undefined, tenantId)[0];
    const client = makeMockClient(JSON.stringify({
      preferences: [],
      facts: [{
        key: 'runtime',
        value: 'The assistant replaced the project runtime.',
        action: 'update',
        target_id: projectFact.id,
      }],
      decisions: [],
      corrections: [],
    }));

    await extractMemories('Tell me about the runtime.', 'I replaced it.', client, chatId, tenantId, userId);

    expect(getFacts(projectChatId(userId), undefined, tenantId)[0].value).toBe('The project uses Fastify.');
    expect(getFacts(chatId, 'fact', tenantId)[0].value).toBe('The assistant replaced the project runtime.');
    const prompt = ((client.chat as ReturnType<typeof vi.fn>).mock.calls[0][0] as ChatMessage[])[1].content;
    expect(prompt).not.toContain(`\"id\":${projectFact.id}`);
    expect(prompt).not.toContain('The project uses Fastify.');
  });
});

describe('isSubstantiallySimilar', () => {
  it('returns true for near-identical values', () => {
    expect(isSubstantiallySimilar(
      'I prefer TypeScript for development',
      'I prefer TypeScript for development work',
    )).toBe(true);
  });

  it('returns true for identical values', () => {
    expect(isSubstantiallySimilar('hello world', 'hello world')).toBe(true);
  });

  it('returns false for different values', () => {
    expect(isSubstantiallySimilar(
      'I prefer TypeScript for development',
      'Python is great for data science',
    )).toBe(false);
  });

  it('returns true for empty strings', () => {
    expect(isSubstantiallySimilar('', '')).toBe(true);
  });

  it('returns false when one string is empty and other is not', () => {
    expect(isSubstantiallySimilar('hello', '')).toBe(false);
  });

  it('does not treat Chinese values as similar merely because they share one Han character', () => {
    expect(isSubstantiallySimilar('报告格式偏好', '报告发布时间')).toBe(false);
    expect(isSubstantiallySimilar('报告格式偏好', '报告格式偏好')).toBe(true);
  });
});
