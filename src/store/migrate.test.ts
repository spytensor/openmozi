import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeDb, getDb, initDb } from './db.js';
import { runMigrations } from './migrate.js';

let tmpDir: string | null = null;

afterEach(() => {
  closeDb();
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

describe('store/migrate', () => {
  it('adds cron trigger origin to installed databases idempotently', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mozi-migrate-'));
    const dbPath = join(tmpDir, 'legacy-scheduler.db');
    const legacyDb = initDb(dbPath);
    legacyDb.exec(`
      CREATE TABLE cron_task_runs (
        id TEXT PRIMARY KEY,
        cron_task_id TEXT,
        tenant_id TEXT NOT NULL DEFAULT 'default',
        scheduled_for DATETIME NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO cron_task_runs (id, cron_task_id, scheduled_for)
      VALUES ('legacy-run', 'legacy-task', datetime('now'));
    `);
    closeDb();

    runMigrations(dbPath);
    runMigrations(dbPath);

    const columns = getDb().prepare('PRAGMA table_info(cron_task_runs)').all() as Array<{ name: string }>;
    expect(columns.map(column => column.name)).toContain('trigger_origin');
    expect(getDb().prepare("SELECT trigger_origin FROM cron_task_runs WHERE id = 'legacy-run'").get())
      .toEqual({ trigger_origin: 'schedule' });
  });

  it('omits vector_json from fresh digest schema while preserving legacy values', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mozi-migrate-'));
    const freshPath = join(tmpDir, 'fresh.db');
    runMigrations(freshPath);
    const freshColumns = getDb().prepare('PRAGMA table_info(session_digests)').all() as Array<{ name: string }>;
    expect(freshColumns.map((column) => column.name)).not.toContain('vector_json');
    closeDb();

    const legacyPath = join(tmpDir, 'legacy-digest.db');
    const legacyDb = initDb(legacyPath);
    legacyDb.exec(`
      CREATE TABLE session_digests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL DEFAULT 'default',
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        digest TEXT NOT NULL,
        topics TEXT,
        open_threads TEXT,
        message_count INTEGER NOT NULL DEFAULT 0,
        session_start TEXT,
        session_end TEXT,
        vector_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(tenant_id, session_id)
      );
      INSERT INTO session_digests (tenant_id, session_id, user_id, digest, vector_json)
      VALUES ('legacy', 'legacy-session', 'legacy-user', 'legacy digest', '[0.1,0.2]');
    `);
    closeDb();

    runMigrations(legacyPath);
    runMigrations(legacyPath);
    const legacyRow = getDb().prepare(
      'SELECT vector_json FROM session_digests WHERE tenant_id = ? AND session_id = ?',
    ).get('legacy', 'legacy-session') as { vector_json: string };
    expect(legacyRow.vector_json).toBe('[0.1,0.2]');
  });

  it('adds truthful usage telemetry columns to legacy billing rows idempotently', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mozi-migrate-'));
    const dbPath = join(tmpDir, 'legacy-billing.db');
    const legacyDb = initDb(dbPath);
    legacyDb.exec(`
      CREATE TABLE billing_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL DEFAULT 'default',
        record_type TEXT NOT NULL,
        model TEXT,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        cost_usd REAL DEFAULT 0,
        tool TEXT,
        duration_ms INTEGER DEFAULT 0,
        task_id TEXT,
        agent_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO billing_records (tenant_id, record_type, model, input_tokens, output_tokens, cost_usd)
      VALUES ('legacy', 'llm_call', 'unknown-model', 12, 3, 0.01);
    `);
    closeDb();

    runMigrations(dbPath);
    runMigrations(dbPath);

    const db = getDb();
    const row = db.prepare(`
      SELECT user_id, provider, cache_read_tokens, pricing_source, usage_status, price_version, currency, outcome, input_tokens, output_tokens
      FROM billing_records WHERE tenant_id = 'legacy'
    `).get() as Record<string, unknown>;
    expect(row).toEqual({
      user_id: null,
      provider: null,
      cache_read_tokens: null,
      pricing_source: 'unknown',
      usage_status: 'legacy_unverified',
      price_version: null,
      currency: 'usd',
      outcome: 'success',
      input_tokens: 12,
      output_tokens: 3,
    });
  });

  it('adds timeline conversation identity before creating schema indexes on legacy app databases', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mozi-migrate-'));
    const dbPath = join(tmpDir, 'legacy-timeline.db');

    const legacyDb = initDb(dbPath);
    legacyDb.exec(`
      CREATE TABLE session_timeline_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL DEFAULT 'default',
        session_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        turn_id TEXT,
        item_type TEXT NOT NULL CHECK(item_type IN ('message', 'tool_event', 'task_update', 'approval_request', 'artifact')),
        event_key TEXT NOT NULL,
        timestamp_ms INTEGER NOT NULL,
        payload JSON NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(tenant_id, session_id, event_key)
      );
      INSERT INTO session_timeline_events (
        tenant_id, session_id, chat_id, turn_id, item_type, event_key, timestamp_ms, payload
      ) VALUES (
        'tenant-1', 'session-1', 'chat-1', 'turn-1', 'message', 'message:legacy-user', 1000,
        '{"role":"user","content":"继续","timestamp":1000}'
      );
    `);
    closeDb();

    runMigrations(dbPath);
    runMigrations(dbPath);

    const db = getDb();
    const columns = db.prepare("PRAGMA table_info(session_timeline_events)").all() as Array<{ name: string }>;
    expect(columns.some(column => column.name === 'conversation_id')).toBe(true);

    const indexes = db.prepare("PRAGMA index_list('session_timeline_events')").all() as Array<{ name: string }>;
    expect(indexes.some(index => index.name === 'idx_session_timeline_conversation')).toBe(true);

    expect(db.prepare(`
      SELECT conversation_id, payload
      FROM session_timeline_events
      WHERE tenant_id = 'tenant-1' AND session_id = 'session-1'
    `).get()).toEqual({
      conversation_id: null,
      payload: '{"role":"user","content":"继续","timestamp":1000}',
    });

    expect(() => db.prepare(`
      INSERT INTO session_timeline_events (
        tenant_id, session_id, chat_id, turn_id, item_type, event_key, timestamp_ms, payload
      ) VALUES ('tenant-1', 'session-1', 'chat-1', 'turn-1', 'memory_update', 'memory:turn-1', 1001, '{}')
    `).run()).not.toThrow();

    // Issue #735: the rebuilt CHECK also admits typed plan events.
    expect(() => db.prepare(`
      INSERT INTO session_timeline_events (
        tenant_id, session_id, chat_id, turn_id, item_type, event_key, timestamp_ms, payload
      ) VALUES ('tenant-1', 'session-1', 'chat-1', 'turn-1', 'plan_started', 'plan:root-1', 1002, '{}')
    `).run()).not.toThrow();
  });

  it('migrates dynamic_tools uniqueness from global name to tenant-scoped name', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mozi-migrate-'));
    const dbPath = join(tmpDir, 'legacy.db');

    // Simulate legacy schema before tenant-scoped uniqueness migration.
    const legacyDb = initDb(dbPath);
    legacyDb.exec(`
      CREATE TABLE dynamic_tools (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL DEFAULT 'default',
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL,
        parameters_schema TEXT NOT NULL,
        handler_type TEXT NOT NULL DEFAULT 'bash',
        handler_path TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    legacyDb
      .prepare(`
        INSERT INTO dynamic_tools (tenant_id, name, description, parameters_schema, handler_type, handler_path, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        'tenant_alpha',
        'shared_tool',
        'legacy tool',
        '{"type":"object","properties":{},"required":[],"additionalProperties":false}',
        'bash',
        '/tmp/shared_tool.sh',
        '2026-01-01T00:00:00Z',
      );

    closeDb();

    runMigrations(dbPath);

    const db = getDb();
    db.prepare(`
      INSERT INTO dynamic_tools (tenant_id, name, description, parameters_schema, handler_type, handler_path, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'tenant_beta',
      'shared_tool',
      'new tenant tool',
      '{"type":"object","properties":{},"required":[],"additionalProperties":false}',
      'bash',
      '/tmp/shared_tool_beta.sh',
      '2026-01-02T00:00:00Z',
    );

    const rows = db
      .prepare('SELECT tenant_id, name FROM dynamic_tools WHERE name = ? ORDER BY tenant_id')
      .all('shared_tool') as Array<{ tenant_id: string; name: string }>;
    expect(rows).toEqual([
      { tenant_id: 'tenant_alpha', name: 'shared_tool' },
      { tenant_id: 'tenant_beta', name: 'shared_tool' },
    ]);

    expect(() => {
      db.prepare(`
        INSERT INTO dynamic_tools (tenant_id, name, description, parameters_schema, handler_type, handler_path, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        'tenant_alpha',
        'shared_tool',
        'duplicate same tenant',
        '{"type":"object","properties":{},"required":[],"additionalProperties":false}',
        'bash',
        '/tmp/duplicate.sh',
        '2026-01-03T00:00:00Z',
      );
    }).toThrow();
  });

  it('migrates legacy memory_facts without salience columns before creating salience index', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mozi-migrate-'));
    const dbPath = join(tmpDir, 'legacy-memory.db');

    // Simulate a pre-salience memory schema from older versions.
    const legacyDb = initDb(dbPath);
    legacyDb.exec(`
      CREATE TABLE memory_facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL DEFAULT 'default',
        chat_id TEXT NOT NULL,
        category TEXT NOT NULL CHECK(category IN ('preference', 'fact', 'decision', 'lesson')),
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1.0,
        source TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(tenant_id, chat_id, category, key)
      )
    `);
    legacyDb
      .prepare(`
        INSERT INTO memory_facts (tenant_id, chat_id, category, key, value, confidence, source, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        'default',
        'chat-1',
        'preference',
        'timezone',
        'UTC+4',
        0.9,
        'user_message',
        '2026-01-01T00:00:00Z',
        '2026-01-01T00:00:00Z',
      );
    legacyDb.prepare(`
      INSERT INTO memory_facts (tenant_id, chat_id, category, key, value, confidence, source, created_at, updated_at)
      VALUES ('default', '__project__', 'fact', 'assistant_guess', 'Unverified assistant claim', 1.0, 'project_extraction', datetime('now'), datetime('now'))
    `).run();
    legacyDb.exec(`
      CREATE TABLE memory_vector_index_state (
        tenant_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        indexed_at TEXT NOT NULL
      );
      INSERT INTO memory_vector_index_state VALUES ('default', 'legacy-provider', 'legacy-model', 3, datetime('now'));
    `);
    closeDb();

    runMigrations(dbPath);

    const db = getDb();
    const columns = db.prepare("PRAGMA table_info(memory_facts)").all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map((column) => column.name));
    expect(columnNames.has('user_id')).toBe(true);
    expect(columnNames.has('salience_score')).toBe(true);
    expect(columnNames.has('recall_count')).toBe(true);
    expect(columnNames.has('last_recalled_at')).toBe(true);
    expect(columnNames.has('status')).toBe(true);
    expect(columnNames.has('origin_kind')).toBe(true);

    const indexes = db.prepare("PRAGMA index_list('memory_facts')").all() as Array<{ name: string }>;
    expect(indexes.some((index) => index.name === 'idx_memory_facts_salience')).toBe(true);

    const migrated = db
      .prepare('SELECT user_id, salience_score, recall_count, last_recalled_at FROM memory_facts WHERE key = ?')
      .get('timezone') as {
        user_id: string | null;
        salience_score: number;
        recall_count: number;
        last_recalled_at: string | null;
      };
    expect(migrated.user_id).toBeNull();
    expect(migrated.salience_score).toBe(0.5);
    expect(migrated.recall_count).toBe(0);
    expect(migrated.last_recalled_at).toBeNull();

    expect(db.prepare(`
      SELECT status, origin_kind FROM memory_facts WHERE key = 'assistant_guess'
    `).get()).toEqual({ status: 'pending_review', origin_kind: 'assistant' });
    expect(db.prepare(`
      SELECT source, value_snapshot, status_snapshot, origin_kind,
             previous_value_snapshot, previous_status_snapshot, previous_origin_kind, previous_source
      FROM memory_fact_evidence
      WHERE fact_id = (SELECT id FROM memory_facts WHERE key = 'assistant_guess')
    `).get()).toEqual({
      source: 'legacy_project_quarantine',
      value_snapshot: 'Unverified assistant claim',
      status_snapshot: 'pending_review',
      origin_kind: 'assistant',
      previous_value_snapshot: 'Unverified assistant claim',
      previous_status_snapshot: 'active',
      previous_origin_kind: 'legacy',
      previous_source: 'project_extraction',
    });
    expect(db.prepare("SELECT * FROM memory_vector_index_state WHERE tenant_id = 'default'").get()).toBeUndefined();

    db.prepare("UPDATE memory_facts SET status = 'retracted' WHERE key = 'assistant_guess'").run();
    closeDb();
    runMigrations(dbPath);
    expect(getDb().prepare(`
      SELECT status, origin_kind FROM memory_facts WHERE key = 'assistant_guess'
    `).get()).toEqual({ status: 'retracted', origin_kind: 'assistant' });
    expect((getDb().prepare(`
      SELECT COUNT(*) AS count FROM memory_fact_evidence
      WHERE fact_id = (SELECT id FROM memory_facts WHERE key = 'assistant_guess')
    `).get() as { count: number }).count).toBe(1);
  });

  it('migrates legacy pairing tables to tenant-scoped keys', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mozi-migrate-'));
    const dbPath = join(tmpDir, 'legacy-pairing.db');

    const legacyDb = initDb(dbPath);
    legacyDb.exec(`
      CREATE TABLE allowed_users (
        user_id TEXT PRIMARY KEY,
        username TEXT,
        role TEXT NOT NULL DEFAULT 'owner',
        paired_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE pairing_tokens (
        token_hash TEXT PRIMARY KEY,
        role TEXT NOT NULL DEFAULT 'user',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL,
        used INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE pairing_requests (
        code TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        username TEXT NOT NULL,
        channel_type TEXT NOT NULL DEFAULT 'telegram',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL,
        approved INTEGER NOT NULL DEFAULT 0,
        notified INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO allowed_users (user_id, username, role, paired_at)
      VALUES ('legacy-user', 'legacy', 'owner', '2026-01-01T00:00:00Z');
      INSERT INTO pairing_tokens (token_hash, role, created_at, expires_at, used)
      VALUES ('legacy-token', 'user', '2026-01-01T00:00:00Z', '2099-01-01T00:00:00Z', 0);
      INSERT INTO pairing_requests (code, user_id, username, channel_type, created_at, expires_at, approved, notified)
      VALUES ('PAIRCODE', 'legacy-user', 'legacy', 'telegram', '2026-01-01T00:00:00Z', '2099-01-01T00:00:00Z', 0, 0);
    `);
    closeDb();

    runMigrations(dbPath);

    const db = getDb();
    const allowedColumns = db.prepare("PRAGMA table_info(allowed_users)").all() as Array<{ name: string; pk: number }>;
    expect(allowedColumns.find(column => column.name === 'tenant_id')?.pk).toBe(1);
    expect(allowedColumns.find(column => column.name === 'user_id')?.pk).toBe(2);

    expect(db.prepare(`
      SELECT username FROM allowed_users WHERE tenant_id = 'default' AND user_id = 'legacy-user'
    `).get()).toEqual({ username: 'legacy' });

    db.prepare(`
      INSERT INTO allowed_users (tenant_id, user_id, username, role)
      VALUES ('tenant-b', 'legacy-user', 'tenant-b-user', 'owner')
    `).run();
    db.prepare(`
      INSERT INTO pairing_tokens (tenant_id, token_hash, role, expires_at)
      VALUES ('tenant-b', 'legacy-token', 'user', '2099-01-01T00:00:00Z')
    `).run();
    db.prepare(`
      INSERT INTO pairing_requests (tenant_id, code, user_id, username, channel_type, expires_at)
      VALUES ('tenant-b', 'PAIRCODE', 'tenant-b-user', 'tenant-b-user', 'telegram', '2099-01-01T00:00:00Z')
    `).run();

    const userRows = db.prepare(`
      SELECT tenant_id, user_id FROM allowed_users WHERE user_id = 'legacy-user' ORDER BY tenant_id
    `).all();
    expect(userRows).toEqual([
      { tenant_id: 'default', user_id: 'legacy-user' },
      { tenant_id: 'tenant-b', user_id: 'legacy-user' },
    ]);
  });

  it('adds local auth columns to legacy users tables idempotently', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mozi-migrate-'));
    const dbPath = join(tmpDir, 'legacy-users.db');

    const legacyDb = initDb(dbPath);
    legacyDb.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT 'default',
        email TEXT NOT NULL,
        name TEXT,
        avatar_url TEXT,
        auth_provider TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'viewer' CHECK(role IN ('admin', 'operator', 'viewer')),
        onboarding_completed_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_login_at TEXT,
        UNIQUE(tenant_id, auth_provider, provider_id),
        UNIQUE(tenant_id, email)
      );
      INSERT INTO users (id, tenant_id, email, auth_provider, provider_id, role)
      VALUES ('legacy-user', 'default', 'legacy@example.com', 'oauth', 'legacy-provider-id', 'viewer');
    `);
    closeDb();

    runMigrations(dbPath);
    runMigrations(dbPath);

    const db = getDb();
    const columns = db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
    const names = new Set(columns.map(column => column.name));
    expect(names.has('password_hash')).toBe(true);
    expect(names.has('status')).toBe(true);
    expect(names.has('allowed_models')).toBe(true);

    const migrated = db.prepare(`
      SELECT email, password_hash, status, allowed_models
      FROM users
      WHERE id = 'legacy-user'
    `).get() as {
      email: string;
      password_hash: string | null;
      status: string;
      allowed_models: string | null;
    };
    expect(migrated).toEqual({
      email: 'legacy@example.com',
      password_hash: null,
      status: 'active',
      allowed_models: null,
    });
  });

  it('marks interrupted context checkpoints failed while preserving their recovery cursor', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mozi-migrate-'));
    const dbPath = join(tmpDir, 'interrupted-context.db');
    runMigrations(dbPath);
    const db = getDb();
    db.prepare(`
      INSERT INTO context_checkpoints (
        id, tenant_id, user_id, session_id, chat_id, reducer_version,
        source_message_id, model_context_window, threshold, status, stage
      ) VALUES ('checkpoint-1', 'tenant-1', 'user-1', 'session-1', 'chat-1',
        'session-reducer-v1', 42, 128000, 0.7, 'running', 'summarizing')
    `).run();
    closeDb();

    runMigrations(dbPath);

    expect(getDb().prepare(`
      SELECT source_message_id, status, stage, error
      FROM context_checkpoints WHERE id = 'checkpoint-1'
    `).get()).toEqual({
      source_message_id: 42,
      status: 'failed',
      stage: 'failed',
      error: 'Runtime interrupted before checkpoint completion',
    });
  });

  it('additively adds turn_seq + session_turns to a legacy timeline DB without rewriting rows (Issue #627)', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mozi-migrate-'));
    const dbPath = join(tmpDir, 'legacy-timeline.db');
    const legacyDb = initDb(dbPath);
    // Pre-#627 timeline table: turn_id exists, but no turn_seq column and no
    // session_turns table.
    legacyDb.exec(`
      CREATE TABLE session_timeline_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL DEFAULT 'default',
        session_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        turn_id TEXT,
        item_type TEXT NOT NULL,
        event_key TEXT NOT NULL,
        timestamp_ms INTEGER NOT NULL,
        payload JSON NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(tenant_id, session_id, event_key)
      );
      INSERT INTO session_timeline_events (tenant_id, session_id, chat_id, turn_id, item_type, event_key, timestamp_ms, payload)
      VALUES ('default', 'legacy-s', 'legacy-c', 'old_turn', 'message', 'm1', 500, '{"role":"user","content":"hi"}');
    `);
    closeDb();

    // Idempotent across repeated runs.
    runMigrations(dbPath);
    runMigrations(dbPath);

    const db = getDb();
    const cols = (db.prepare(`PRAGMA table_info(session_timeline_events)`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('turn_seq');
    // session_turns table now exists.
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_turns'").get()).toBeTruthy();
    // Legacy row is untouched: content preserved, turn_seq NULL (not backfilled).
    const row = db.prepare(`
      SELECT turn_id, turn_seq, json_extract(payload, '$.content') AS content
      FROM session_timeline_events WHERE event_key = 'm1'
    `).get() as { turn_id: string; turn_seq: number | null; content: string };
    expect(row).toEqual({ turn_id: 'old_turn', turn_seq: null, content: 'hi' });
  });

  it('additively adds the locale column to a pre-#628 session_turns table without rewriting rows', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mozi-migrate-'));
    const dbPath = join(tmpDir, 'legacy-turns.db');
    const legacyDb = initDb(dbPath);
    // Pre-#628 session_turns table: no locale column.
    legacyDb.exec(`
      CREATE TABLE session_turns (
        tenant_id TEXT NOT NULL DEFAULT 'default',
        session_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        origin TEXT NOT NULL DEFAULT 'user',
        status TEXT NOT NULL DEFAULT 'active',
        seq_high_water INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (tenant_id, session_id, turn_id)
      );
      INSERT INTO session_turns (tenant_id, session_id, chat_id, turn_id, origin, status, seq_high_water, started_at)
      VALUES ('default', 'legacy-s', 'legacy-c', 'old_turn', 'user', 'completed', 4, 500);
    `);
    closeDb();

    // Idempotent across repeated runs.
    runMigrations(dbPath);
    runMigrations(dbPath);

    const db = getDb();
    const cols = (db.prepare(`PRAGMA table_info(session_turns)`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('locale');
    // Legacy row untouched: locale NULL (never backfilled), other fields intact.
    const row = db.prepare(`SELECT turn_id, locale, seq_high_water FROM session_turns WHERE turn_id = 'old_turn'`).get() as {
      turn_id: string;
      locale: string | null;
      seq_high_water: number;
    };
    expect(row).toEqual({ turn_id: 'old_turn', locale: null, seq_high_water: 4 });
  });

  it('upgrades legacy scheduler tables to the durable identity and delivery contract', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mozi-migrate-'));
    const dbPath = join(tmpDir, 'legacy-scheduler.db');
    const legacyDb = initDb(dbPath);
    legacyDb.exec(`
      CREATE TABLE reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL DEFAULT 'default',
        chat_id TEXT NOT NULL, message TEXT NOT NULL, fire_at DATETIME NOT NULL,
        fired BOOLEAN NOT NULL DEFAULT 0
      );
      INSERT INTO reminders (chat_id, message, fire_at, fired)
      VALUES ('owner:sess-1', 'legacy delivered', datetime('now'), 1);
      CREATE TABLE background_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL DEFAULT 'default',
        chat_id TEXT NOT NULL, objective TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        result TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, completed_at DATETIME
      );
      INSERT INTO background_tasks (chat_id, objective) VALUES ('owner:sess-1', 'legacy job');
      CREATE TABLE cron_task_runs (
        id TEXT PRIMARY KEY, cron_task_id TEXT, background_task_id INTEGER,
        tenant_id TEXT NOT NULL DEFAULT 'default', scheduled_for DATETIME NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued', result TEXT, error TEXT,
        delivery_status TEXT NOT NULL DEFAULT 'pending', delivery_error TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        started_at DATETIME, completed_at DATETIME
      );
      INSERT INTO cron_task_runs (id, scheduled_for) VALUES ('legacy-run', datetime('now'));
    `);
    closeDb();

    runMigrations(dbPath);
    runMigrations(dbPath);
    const db = getDb();
    const reminderColumns = new Set((db.prepare('PRAGMA table_info(reminders)').all() as Array<{ name: string }>).map(row => row.name));
    for (const column of ['user_id', 'session_id', 'status', 'attempt_count', 'last_error', 'fired_at']) {
      expect(reminderColumns.has(column)).toBe(true);
    }
    expect(db.prepare('SELECT status FROM reminders WHERE id = 1').get()).toEqual({ status: 'delivered' });
    const backgroundColumns = new Set((db.prepare('PRAGMA table_info(background_tasks)').all() as Array<{ name: string }>).map(row => row.name));
    for (const column of ['user_id', 'session_id', 'channel_type', 'cron_run_id', 'delivery_status', 'delivery_attempts']) {
      expect(backgroundColumns.has(column)).toBe(true);
    }
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cron_task_runs'").get()).toBeTruthy();
    const runColumns = new Set((db.prepare('PRAGMA table_info(cron_task_runs)').all() as Array<{ name: string }>).map(row => row.name));
    expect(runColumns.has('session_id')).toBe(true);
  });
});
