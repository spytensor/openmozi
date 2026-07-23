import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../store/db.js';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import { searchDigests } from './session-digest.js';

let tmpDir: string;

beforeAll(() => {
  const setup = setupTestDb();
  tmpDir = setup.tmpDir;
});

afterAll(() => {
  teardownTestDb(tmpDir);
});

describe('memory/session-digest search', () => {
  it('matches Chinese words without accepting a shared single Han character', () => {
    const db = getDb();
    const insert = db.prepare(`
      INSERT INTO session_digests (
        tenant_id, session_id, user_id, digest, topics, open_threads, message_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run('digest-cjk', 'session-report', 'user-cjk', '确认了报告格式', '["报告"]', '[]', 4);
    insert.run('digest-cjk', 'session-tax', 'user-cjk', '确认了报税材料', '["报税"]', '[]', 4);

    const results = searchDigests('user-cjk', '继续处理报告', 'digest-cjk', 5);

    expect(results.map(result => result.session_id)).toContain('session-report');
    expect(results.map(result => result.session_id)).not.toContain('session-tax');
  });
});

describe('memory/session-digest sweep', () => {
  /** Stub summary-tier client: sweep tests exercise candidate selection and
   *  wiring, not LLM quality; digest content is asserted only for shape. */
  const stubClient = {
    provider: 'stub',
    chat: async () => ({
      content: '{"digest":"用户与助手讨论了债券市场并得出结论。总结完成。","topics":["bonds"],"open_threads":[]}',
      model: 'stub',
      tokens_used: 0,
    }),
    chatStream: async () => { throw new Error('not used'); },
  } as unknown as import('../core/llm.js').LLMClient;

  function makeSession(tenant: string, messageCount: number, idleHoursAgo: number): string {
    const db = getDb();
    const id = `sweep-${Math.random().toString(36).slice(2, 10)}`;
    db.prepare(`
      INSERT INTO sessions (id, tenant_id, user_id, title, updated_at)
      VALUES (?, ?, 'sweep-user', 'test', datetime('now', ?))
    `).run(id, tenant, `-${idleHoursAgo} hours`);
    const insertMsg = db.prepare(`
      INSERT INTO conversations (tenant_id, chat_id, session_id, role, content)
      VALUES (?, 'sweep-chat', ?, ?, ?)
    `);
    for (let i = 0; i < messageCount; i++) {
      insertMsg.run(tenant, id, i % 2 === 0 ? 'user' : 'assistant', `message ${i}`);
    }
    return id;
  }

  it('digests idle sessions and is idempotent across sweeps', async () => {
    const { sweepStaleSessionDigests, hasDigest } = await import('./session-digest.js');
    await drainSweep();
    const tenant = 'sweep-t1';
    const idle = makeSession(tenant, 6, 30);
    const fresh = makeSession(tenant, 6, 1);

    const attempted = await sweepStaleSessionDigests(() => stubClient);
    expect(attempted).toBeGreaterThanOrEqual(1);
    expect(hasDigest(idle, tenant)).toBe(true);
    expect(hasDigest(fresh, tenant)).toBe(false);

    // Second sweep: digested session no longer a candidate.
    const again = await sweepStaleSessionDigests(() => stubClient);
    expect(hasDigest(idle, tenant)).toBe(true);
    expect(again).toBe(0);
  });

  /** Digest every pending candidate so tests stay order-independent. */
  async function drainSweep(): Promise<void> {
    const { sweepStaleSessionDigests } = await import('./session-digest.js');
    while (await sweepStaleSessionDigests(() => stubClient, { maxPerSweep: 50 }) > 0) { /* drain */ }
  }

  it('excludes sessions below the message floor so they cannot starve the LIMIT', async () => {
    const { sweepStaleSessionDigests, hasDigest } = await import('./session-digest.js');
    await drainSweep();
    const tenant = 'sweep-t2';
    // Six tiny sessions newer than the real candidate would exhaust maxPerSweep
    // if the floor were enforced only inside generateAndSaveDigest.
    for (let i = 0; i < 6; i++) makeSession(tenant, 2, 25);
    const real = makeSession(tenant, 6, 48);

    const attempted = await sweepStaleSessionDigests(() => stubClient, { maxPerSweep: 5 });
    expect(hasDigest(real, tenant)).toBe(true);
    expect(attempted).toBe(1);
  });

  it('caps candidates processed per sweep', async () => {
    const { sweepStaleSessionDigests } = await import('./session-digest.js');
    await drainSweep();
    const tenant = 'sweep-t3';
    for (let i = 0; i < 4; i++) makeSession(tenant, 6, 30);

    const attempted = await sweepStaleSessionDigests(() => stubClient, { maxPerSweep: 2 });
    expect(attempted).toBe(2);
  });
});
