import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initDb } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

type MigrationDb = ReturnType<typeof initDb>;

function getTableSql(db: MigrationDb, tableName: string): string {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { sql?: string } | undefined;
  return row?.sql ?? '';
}

function tableExists(db: MigrationDb, tableName: string): boolean {
  return Boolean(getTableSql(db, tableName));
}

function tableHasColumn(db: MigrationDb, tableName: string, columnName: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return columns.some(column => column.name === columnName);
}

function ensureBillingTelemetryColumns(db: MigrationDb): void {
  if (!tableExists(db, 'billing_records')) return;
  for (const [column, definition] of [
    ['user_id', 'TEXT'],
    ['provider', 'TEXT'],
    ['cache_read_tokens', 'INTEGER'],
    ['cache_write_tokens', 'INTEGER'],
    ['input_cost_per_million', 'REAL'],
    ['output_cost_per_million', 'REAL'],
    ['cache_read_cost_per_million', 'REAL'],
    ['cache_write_cost_per_million', 'REAL'],
    ['pricing_source', "TEXT NOT NULL DEFAULT 'unknown'"],
    ['usage_status', "TEXT NOT NULL DEFAULT 'legacy_unverified'"],
    ['price_version', 'TEXT'],
    ['currency', "TEXT NOT NULL DEFAULT 'usd'"],
    ['outcome', "TEXT NOT NULL DEFAULT 'success'"],
    ['failure_category', 'TEXT'],
  ] as const) {
    if (!tableHasColumn(db, 'billing_records', column)) {
      db.exec(`ALTER TABLE billing_records ADD COLUMN ${column} ${definition}`);
    }
  }
}

/**
 * `artifact_versions` predates the repo-wide "every table carries tenant_id"
 * rule and shipped without one, so `getLatestArtifactVersion` could resolve any
 * tenant's record from a model-supplied artifact_id. Nothing but the filesystem
 * policy stood between tenants; this gives the data layer its own isolation.
 *
 * Existing rows are backfilled to 'default', matching the single-tenant default
 * every installed database has been writing under.
 */
function ensureArtifactVersionsTenantColumn(db: MigrationDb): void {
  if (!tableExists(db, 'artifact_versions')) return;
  if (tableHasColumn(db, 'artifact_versions', 'tenant_id')) return;
  db.exec("ALTER TABLE artifact_versions ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'");
}

function ensureSessionTimelineConversationColumn(db: MigrationDb): void {
  if (!tableExists(db, 'session_timeline_events')) return;
  if (!tableHasColumn(db, 'session_timeline_events', 'conversation_id')) {
    db.exec('ALTER TABLE session_timeline_events ADD COLUMN conversation_id INTEGER');
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_session_timeline_conversation
      ON session_timeline_events(tenant_id, session_id, conversation_id)
  `);
}

/**
 * Issue #627: add the durable per-turn sequence column to existing timeline
 * tables. Additive and idempotent — legacy rows keep turn_seq = NULL, so
 * historical sessions are never rewritten and remain readable.
 */
function ensureSessionTimelineTurnSeqColumn(db: MigrationDb): void {
  if (!tableExists(db, 'session_timeline_events')) return;
  if (!tableHasColumn(db, 'session_timeline_events', 'turn_seq')) {
    db.exec('ALTER TABLE session_timeline_events ADD COLUMN turn_seq INTEGER');
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_session_timeline_turn_seq
      ON session_timeline_events(tenant_id, session_id, turn_id, turn_seq ASC)
  `);
}

/**
 * Extend the lossless UI timeline's item_type CHECK to the current type set
 * (memory_update, and plan_started for Issue #735's typed plan events).
 * SQLite cannot alter a CHECK constraint in place, so legacy tables are rebuilt
 * transactionally after their additive columns have been ensured. Every row and
 * authoritative id/sequence is copied byte-for-byte before the old table drops.
 * Gated on the newest member: a table that already allows it needs nothing.
 */
function ensureSessionTimelineItemTypes(db: MigrationDb): void {
  if (!tableExists(db, 'session_timeline_events')) return;
  const tableSql = getTableSql(db, 'session_timeline_events').replace(/\s+/g, ' ').toUpperCase();
  if (tableSql.includes("'PLAN_STARTED'")) return;

  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec('DROP TABLE IF EXISTS session_timeline_events_legacy_item_types');
    db.exec('ALTER TABLE session_timeline_events RENAME TO session_timeline_events_legacy_item_types');
    db.exec(`
      CREATE TABLE session_timeline_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL DEFAULT 'default',
        session_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        turn_id TEXT,
        turn_seq INTEGER,
        conversation_id INTEGER,
        item_type TEXT NOT NULL CHECK(item_type IN ('message', 'tool_event', 'task_update', 'plan_started', 'approval_request', 'artifact', 'memory_update')),
        event_key TEXT NOT NULL,
        timestamp_ms INTEGER NOT NULL,
        payload JSON NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(tenant_id, session_id, event_key)
      );
      INSERT INTO session_timeline_events (
        id, tenant_id, session_id, chat_id, turn_id, turn_seq, conversation_id,
        item_type, event_key, timestamp_ms, payload, created_at, updated_at
      )
      SELECT
        id, tenant_id, session_id, chat_id, turn_id, turn_seq, conversation_id,
        item_type, event_key, timestamp_ms, payload, created_at, updated_at
      FROM session_timeline_events_legacy_item_types;
      DROP TABLE session_timeline_events_legacy_item_types;
      CREATE INDEX idx_session_timeline_order
        ON session_timeline_events(tenant_id, session_id, timestamp_ms ASC, id ASC);
      CREATE INDEX idx_session_timeline_turn
        ON session_timeline_events(tenant_id, session_id, turn_id);
      CREATE INDEX idx_session_timeline_turn_seq
        ON session_timeline_events(tenant_id, session_id, turn_id, turn_seq ASC);
      CREATE INDEX idx_session_timeline_conversation
        ON session_timeline_events(tenant_id, session_id, conversation_id);
    `);
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Ignore rollback errors and preserve the original migration failure.
    }
    throw err;
  }
}

/**
 * Issue #628: carry the authoritative per-turn presentation locale on the Turn
 * Envelope. Additive and idempotent — the canonical `session_turns` table is
 * created by schema.sql with `CREATE TABLE IF NOT EXISTS`, which never adds a
 * column to a pre-existing table, so existing App databases need this ALTER.
 * Legacy rows keep locale = NULL and consumers fall back to their own default.
 */
function ensureSessionTurnsLocaleColumn(db: MigrationDb): void {
  if (!tableExists(db, 'session_turns')) return;
  if (!tableHasColumn(db, 'session_turns', 'locale')) {
    db.exec('ALTER TABLE session_turns ADD COLUMN locale TEXT');
  }
}

/** Additive scheduler contract migration for installed databases. */
function ensureSchedulerContract(db: MigrationDb): void {
  if (tableExists(db, 'reminders')) {
    const hadStatusColumn = tableHasColumn(db, 'reminders', 'status');
    for (const [column, definition] of [
      ['user_id', 'TEXT'],
      ['session_id', 'TEXT'],
      ['channel_type', 'TEXT'],
      ['status', "TEXT NOT NULL DEFAULT 'pending'"],
      ['attempt_count', 'INTEGER NOT NULL DEFAULT 0'],
      ['max_attempts', 'INTEGER NOT NULL DEFAULT 5'],
      ['next_attempt_at', 'INTEGER'],
      ['last_attempt_at', 'DATETIME'],
      ['last_error', 'TEXT'],
      ['fired_at', 'DATETIME'],
      ['created_at', 'DATETIME'],
    ] as const) {
      if (!tableHasColumn(db, 'reminders', column)) {
        db.exec(`ALTER TABLE reminders ADD COLUMN ${column} ${definition}`);
      }
    }
    db.exec(`UPDATE reminders SET status = CASE WHEN fired = 1 THEN 'delivered' ELSE 'pending' END${hadStatusColumn ? " WHERE status IS NULL OR status = ''" : ''}`);
    db.exec("UPDATE reminders SET created_at = COALESCE(created_at, fire_at, datetime('now'))");
    db.exec('DROP INDEX IF EXISTS idx_reminders_due');
    db.exec('CREATE INDEX idx_reminders_due ON reminders(tenant_id, status, fire_at, next_attempt_at)');
  }

  if (tableExists(db, 'cron_tasks')) {
    for (const [column, definition] of [
      ['user_id', 'TEXT'],
      ['session_id', 'TEXT'],
      ['channel_type', 'TEXT'],
      ['permission_level', 'TEXT'],
    ] as const) {
      if (!tableHasColumn(db, 'cron_tasks', column)) {
        db.exec(`ALTER TABLE cron_tasks ADD COLUMN ${column} ${definition}`);
      }
    }
    db.exec('DROP INDEX IF EXISTS idx_cron_tasks_tenant');
    db.exec('CREATE INDEX idx_cron_tasks_tenant ON cron_tasks(tenant_id, enabled, next_run_at)');
  }

  if (tableExists(db, 'cron_task_runs')) {
    if (!tableHasColumn(db, 'cron_task_runs', 'session_id')) {
      db.exec('ALTER TABLE cron_task_runs ADD COLUMN session_id TEXT');
    }
    if (!tableHasColumn(db, 'cron_task_runs', 'trigger_origin')) {
      db.exec("ALTER TABLE cron_task_runs ADD COLUMN trigger_origin TEXT NOT NULL DEFAULT 'schedule'");
    }
  }

  if (tableExists(db, 'background_tasks')) {
    for (const [column, definition] of [
      ['user_id', 'TEXT'],
      ['session_id', 'TEXT'],
      ['channel_type', 'TEXT'],
      ['permission_level', 'TEXT'],
      ['source_cron_task_id', 'TEXT'],
      ['cron_run_id', 'TEXT'],
      ['delivery_status', "TEXT NOT NULL DEFAULT 'none'"],
      ['delivery_attempts', 'INTEGER NOT NULL DEFAULT 0'],
      ['delivery_after', 'INTEGER'],
      ['delivery_error', 'TEXT'],
    ] as const) {
      if (!tableHasColumn(db, 'background_tasks', column)) {
        db.exec(`ALTER TABLE background_tasks ADD COLUMN ${column} ${definition}`);
      }
    }
  }
}

function createAllowedUsersTable(db: MigrationDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS allowed_users (
      tenant_id TEXT NOT NULL DEFAULT 'default',
      user_id TEXT NOT NULL,
      username TEXT,
      role TEXT NOT NULL DEFAULT 'owner',
      paired_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (tenant_id, user_id)
    );
  `);
}

function createPairingTokensTable(db: MigrationDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pairing_tokens (
      tenant_id TEXT NOT NULL DEFAULT 'default',
      token_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (tenant_id, token_hash)
    );
  `);
}

function createPairingRequestsTable(db: MigrationDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pairing_requests (
      tenant_id TEXT NOT NULL DEFAULT 'default',
      code TEXT NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      channel_type TEXT NOT NULL DEFAULT 'telegram',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      approved INTEGER NOT NULL DEFAULT 0,
      notified INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (tenant_id, code)
    );
  `);
}

function createPairingIndexes(db: MigrationDb): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_allowed_users_tenant_role
      ON allowed_users(tenant_id, role);
    CREATE INDEX IF NOT EXISTS idx_pairing_tokens_tenant_active
      ON pairing_tokens(tenant_id, used, expires_at);
    CREATE INDEX IF NOT EXISTS idx_pairing_requests_tenant_pending
      ON pairing_requests(tenant_id, approved, expires_at);
  `);
}

function createTenantScopedPairingTables(db: MigrationDb): void {
  createAllowedUsersTable(db);
  createPairingTokensTable(db);
  createPairingRequestsTable(db);
  createPairingIndexes(db);
}

function migratePairingTables(db: MigrationDb): void {
  const allowedUsersSql = getTableSql(db, 'allowed_users').replace(/\s+/g, ' ').toUpperCase();
  if (tableExists(db, 'allowed_users') && !allowedUsersSql.includes('PRIMARY KEY (TENANT_ID, USER_ID)')) {
    const hasTenantId = tableHasColumn(db, 'allowed_users', 'tenant_id');
    try {
      db.exec('BEGIN IMMEDIATE');
      db.exec('DROP TABLE IF EXISTS allowed_users_legacy_migration');
      db.exec('ALTER TABLE allowed_users RENAME TO allowed_users_legacy_migration');
      createAllowedUsersTable(db);
      db.exec(`
        INSERT OR REPLACE INTO allowed_users (tenant_id, user_id, username, role, paired_at)
        SELECT
          ${hasTenantId ? "COALESCE(tenant_id, 'default')" : "'default'"},
          user_id,
          username,
          COALESCE(role, 'owner'),
          COALESCE(paired_at, datetime('now'))
        FROM allowed_users_legacy_migration
      `);
      db.exec('DROP TABLE allowed_users_legacy_migration');
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Ignore rollback errors.
      }
      throw err;
    }
  }

  const pairingTokensSql = getTableSql(db, 'pairing_tokens').replace(/\s+/g, ' ').toUpperCase();
  if (tableExists(db, 'pairing_tokens') && !pairingTokensSql.includes('PRIMARY KEY (TENANT_ID, TOKEN_HASH)')) {
    const hasTenantId = tableHasColumn(db, 'pairing_tokens', 'tenant_id');
    try {
      db.exec('BEGIN IMMEDIATE');
      db.exec('DROP TABLE IF EXISTS pairing_tokens_legacy_migration');
      db.exec('ALTER TABLE pairing_tokens RENAME TO pairing_tokens_legacy_migration');
      createPairingTokensTable(db);
      db.exec(`
        INSERT OR REPLACE INTO pairing_tokens (tenant_id, token_hash, role, created_at, expires_at, used)
        SELECT
          ${hasTenantId ? "COALESCE(tenant_id, 'default')" : "'default'"},
          token_hash,
          COALESCE(role, 'user'),
          COALESCE(created_at, datetime('now')),
          expires_at,
          COALESCE(used, 0)
        FROM pairing_tokens_legacy_migration
      `);
      db.exec('DROP TABLE pairing_tokens_legacy_migration');
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Ignore rollback errors.
      }
      throw err;
    }
  }

  const pairingRequestsSql = getTableSql(db, 'pairing_requests').replace(/\s+/g, ' ').toUpperCase();
  if (tableExists(db, 'pairing_requests') && !pairingRequestsSql.includes('PRIMARY KEY (TENANT_ID, CODE)')) {
    const hasTenantId = tableHasColumn(db, 'pairing_requests', 'tenant_id');
    try {
      db.exec('BEGIN IMMEDIATE');
      db.exec('DROP TABLE IF EXISTS pairing_requests_legacy_migration');
      db.exec('ALTER TABLE pairing_requests RENAME TO pairing_requests_legacy_migration');
      createPairingRequestsTable(db);
      db.exec(`
        INSERT OR REPLACE INTO pairing_requests (
          tenant_id, code, user_id, username, channel_type, created_at, expires_at, approved, notified
        )
        SELECT
          ${hasTenantId ? "COALESCE(tenant_id, 'default')" : "'default'"},
          code,
          user_id,
          username,
          COALESCE(channel_type, 'telegram'),
          COALESCE(created_at, datetime('now')),
          expires_at,
          COALESCE(approved, 0),
          COALESCE(notified, 0)
        FROM pairing_requests_legacy_migration
      `);
      db.exec('DROP TABLE pairing_requests_legacy_migration');
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Ignore rollback errors.
      }
      throw err;
    }
  }

  createTenantScopedPairingTables(db);
}

/** Run database migrations from schema.sql */
export function runMigrations(dbPath?: string): void {
  const db = initDb(dbPath);

  // Legacy databases may already have `dynamic_tools` without lifecycle columns.
  // Ensure these columns exist before loading schema indexes that reference them.
  const hasDynamicToolsTable = Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'dynamic_tools'").get(),
  );
  if (hasDynamicToolsTable) {
    try {
      db.exec("ALTER TABLE dynamic_tools ADD COLUMN status TEXT NOT NULL DEFAULT 'draft'");
    } catch {
      // Column already exists — ignore
    }
    try {
      db.exec('ALTER TABLE dynamic_tools ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0');
    } catch {
      // Column already exists — ignore
    }
    try {
      db.exec('ALTER TABLE dynamic_tools ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0');
    } catch {
      // Column already exists — ignore
    }
    try {
      db.exec('ALTER TABLE dynamic_tools ADD COLUMN last_used_at TEXT');
    } catch {
      // Column already exists — ignore
    }
  }

  // Pairing tables used to have global primary keys. Rebuild them before
  // schema.sql creates tenant-scoped pairing indexes.
  migratePairingTables(db);
  // New billing indexes reference these columns, so legacy tables must be
  // expanded before schema.sql attempts to create the indexes.
  ensureBillingTelemetryColumns(db);
  // schema.sql contains an index over conversation_id. Existing App databases
  // already have the timeline table, so the column must exist before the
  // canonical schema/index batch runs.
  ensureSessionTimelineConversationColumn(db);
  // schema.sql declares an index over (tenant_id, artifact_id); legacy tables
  // predate the column, so add it before the canonical index batch.
  ensureArtifactVersionsTenantColumn(db);
  // schema.sql declares an index over (turn_id, turn_seq); legacy timeline
  // tables predate the column, so add it before the canonical index batch.
  ensureSessionTimelineTurnSeqColumn(db);
  // Existing tables carry a CHECK constraint that predates memory_update /
  // plan_started. Rebuild before schema.sql creates/uses the timeline indexes.
  ensureSessionTimelineItemTypes(db);

  // Existing scheduler tables must gain columns before schema.sql creates
  // indexes that reference them.
  ensureSchedulerContract(db);

  // Try multiple paths since tsup splitting may move chunks
  let schemaPath = join(__dirname, 'schema.sql');
  if (!existsSync(schemaPath)) {
    schemaPath = join(__dirname, 'store', 'schema.sql');
  }
  const schema = readFileSync(schemaPath, 'utf-8');
  db.exec(schema);
  db.exec('DROP INDEX IF EXISTS idx_runtime_state_lookup');

  // schema.sql creates session_turns only when absent; add the Issue #628 locale
  // column to databases whose table predates it.
  ensureSessionTurnsLocaleColumn(db);
  ensureSchedulerContract(db);

  ensureBillingTelemetryColumns(db);
  db.exec('CREATE INDEX IF NOT EXISTS idx_billing_tenant_user_date ON billing_records(tenant_id, user_id, created_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_billing_tenant_model_date ON billing_records(tenant_id, provider, model, created_at)');

  // Migrate dynamic_tools unique constraint from global `name` to tenant-scoped `(tenant_id, name)`.
  const dynamicToolsTable = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'dynamic_tools'")
    .get() as { sql?: string } | undefined;
  const dynamicToolsSql = (dynamicToolsTable?.sql ?? '').replace(/\s+/g, ' ').toUpperCase();
  const hasLegacyGlobalUnique = dynamicToolsSql.includes('NAME TEXT NOT NULL UNIQUE');
  const hasTenantScopedUnique = dynamicToolsSql.includes('UNIQUE(TENANT_ID, NAME)');
  if (hasLegacyGlobalUnique && !hasTenantScopedUnique) {
    try {
      db.exec('BEGIN IMMEDIATE');
      db.exec('ALTER TABLE dynamic_tools RENAME TO dynamic_tools_legacy');
      db.exec(`
        CREATE TABLE dynamic_tools (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          name TEXT NOT NULL,
          description TEXT NOT NULL,
          parameters_schema TEXT NOT NULL,
          handler_type TEXT NOT NULL DEFAULT 'bash',
          handler_path TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'active', 'deprecated')),
          use_count INTEGER NOT NULL DEFAULT 0,
          failure_count INTEGER NOT NULL DEFAULT 0,
          last_used_at TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(tenant_id, name)
        )
      `);
      db.exec(`
        INSERT INTO dynamic_tools (
          id, tenant_id, name, description, parameters_schema, handler_type, handler_path,
          status, use_count, failure_count, last_used_at, created_at
        )
        SELECT
          id, tenant_id, name, description, parameters_schema, handler_type, handler_path,
          'active', 0, 0, NULL, created_at
        FROM dynamic_tools_legacy
      `);
      db.exec('DROP TABLE dynamic_tools_legacy');
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Ignore rollback errors.
      }
      throw err;
    }
  }

  // Add dynamic tool lifecycle columns
  try {
    db.exec("ALTER TABLE dynamic_tools ADD COLUMN status TEXT NOT NULL DEFAULT 'draft'");
  } catch {
    // Column already exists — ignore
  }
  try {
    db.exec('ALTER TABLE dynamic_tools ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0');
  } catch {
    // Column already exists — ignore
  }
  try {
    db.exec('ALTER TABLE dynamic_tools ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0');
  } catch {
    // Column already exists — ignore
  }
  try {
    db.exec('ALTER TABLE dynamic_tools ADD COLUMN last_used_at TEXT');
  } catch {
    // Column already exists — ignore
  }
  db.exec("UPDATE dynamic_tools SET status = 'draft' WHERE status IS NULL OR status = ''");
  db.exec('CREATE INDEX IF NOT EXISTS idx_dynamic_tools_status ON dynamic_tools(tenant_id, status, last_used_at DESC)');

  // Incremental migrations for existing databases
  // Add session_id column to conversations (idempotent)
  try {
    db.exec('ALTER TABLE conversations ADD COLUMN session_id TEXT');
  } catch {
    // Column already exists — ignore
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_conv_session ON conversations(session_id)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS context_checkpoints (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      reducer_version TEXT NOT NULL,
      source_message_id INTEGER NOT NULL,
      retained_from_message_id INTEGER,
      summary TEXT,
      source_token_count INTEGER NOT NULL DEFAULT 0,
      summary_token_count INTEGER NOT NULL DEFAULT 0,
      model_context_window INTEGER NOT NULL,
      threshold REAL NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'failed')),
      stage TEXT NOT NULL DEFAULT 'preparing',
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tenant_id, session_id, reducer_version, source_message_id)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_context_checkpoints_session ON context_checkpoints(tenant_id, session_id, status, source_message_id DESC)');
  db.exec(`
    UPDATE context_checkpoints
    SET status = 'failed', stage = 'failed', error = 'Runtime interrupted before checkpoint completion', updated_at = datetime('now')
    WHERE status IN ('pending', 'running')
  `);

  ensureSessionTimelineConversationColumn(db);
  ensureSessionTimelineTurnSeqColumn(db);
  ensureSessionTurnsLocaleColumn(db);

  // Add metadata column to conversations (idempotent) — JSON blob for per-message
  // extras such as uploaded-file attachments, so attachment chips survive reload.
  try {
    db.exec('ALTER TABLE conversations ADD COLUMN metadata TEXT');
  } catch {
    // Column already exists — ignore
  }

  // Add persisted workspace context to sessions for project-scoped chat restore.
  try {
    db.exec('ALTER TABLE sessions ADD COLUMN workspace_root_id TEXT');
  } catch {
    // Column already exists — ignore
  }
  try {
    db.exec('ALTER TABLE sessions ADD COLUMN workspace_context JSON');
  } catch {
    // Column already exists — ignore
  }
  // Project ownership and turn execution scope have different lifetimes.  The
  // former is immutable conversation history; the latter may be changed by an
  // explicit user transition.  Backfill both from the legacy combined fields.
  for (const [column, type] of [
    ['project_root_id', 'TEXT'],
    ['project_context', 'JSON'],
    ['execution_root_id', 'TEXT'],
    ['execution_context', 'JSON'],
  ] as const) {
    try {
      db.exec(`ALTER TABLE sessions ADD COLUMN ${column} ${type}`);
    } catch {
      // Column already exists — ignore
    }
  }
  db.exec(`
    UPDATE sessions
    SET project_root_id = COALESCE(project_root_id, workspace_root_id),
        project_context = COALESCE(project_context, workspace_context),
        execution_root_id = COALESCE(execution_root_id, workspace_root_id),
        execution_context = COALESCE(execution_context, workspace_context)
    WHERE project_root_id IS NULL OR project_context IS NULL
       OR execution_root_id IS NULL OR execution_context IS NULL
  `);
  try {
    // Per-session out-of-project-scope write grants (P3 escalation).
    db.exec('ALTER TABLE sessions ADD COLUMN scope_grants JSON');
  } catch {
    // Column already exists — ignore
  }
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN permission_level TEXT NOT NULL DEFAULT 'L3_FULL_ACCESS'");
  } catch {
    // Column already exists — ignore
  }
  db.exec("UPDATE sessions SET permission_level = 'L3_FULL_ACCESS' WHERE permission_level IS NULL OR permission_level = ''");

  // Add user_id column to memory_facts for cross-session memory
  try {
    db.exec('ALTER TABLE memory_facts ADD COLUMN user_id TEXT');
  } catch {
    // Column already exists — ignore
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_memory_facts_user ON memory_facts(user_id, tenant_id)');

  // Project-memory trust lifecycle and provenance. Legacy assistant-derived
  // project facts are quarantined for explicit review instead of being injected.
  try {
    db.exec("ALTER TABLE memory_facts ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'pending_review', 'disputed', 'retracted'))");
  } catch {
    // Column already exists — ignore
  }
  try {
    db.exec("ALTER TABLE memory_facts ADD COLUMN origin_kind TEXT NOT NULL DEFAULT 'legacy' CHECK(origin_kind IN ('user', 'tool', 'assistant', 'manual', 'legacy'))");
  } catch {
    // Column already exists — ignore
  }
  for (const [column, type] of [
    ['value_snapshot', 'TEXT'],
    ['status_snapshot', "TEXT CHECK(status_snapshot IS NULL OR status_snapshot IN ('active', 'pending_review', 'disputed', 'retracted'))"],
    ['origin_kind', "TEXT CHECK(origin_kind IS NULL OR origin_kind IN ('user', 'tool', 'assistant', 'manual', 'legacy'))"],
    ['previous_value_snapshot', 'TEXT'],
    ['previous_status_snapshot', "TEXT CHECK(previous_status_snapshot IS NULL OR previous_status_snapshot IN ('active', 'pending_review', 'disputed', 'retracted'))"],
    ['previous_origin_kind', "TEXT CHECK(previous_origin_kind IS NULL OR previous_origin_kind IN ('user', 'tool', 'assistant', 'manual', 'legacy'))"],
    ['previous_source', 'TEXT'],
  ] as const) {
    try {
      db.exec(`ALTER TABLE memory_fact_evidence ADD COLUMN ${column} ${type}`);
    } catch {
      // Column already exists — ignore
    }
  }

  const projectQuarantineWhere = `
    chat_id = '__project__'
      AND source = 'project_extraction'
      AND user_id IS NULL
      AND status = 'active'
  `;
  const quarantinedTenants = db.prepare(`
    SELECT DISTINCT tenant_id FROM memory_facts WHERE ${projectQuarantineWhere}
  `).all() as Array<{ tenant_id: string }>;
  db.exec(`
    INSERT INTO memory_fact_evidence (
      tenant_id, fact_id, chat_id, user_id, turn_id, action, source,
      value_snapshot, status_snapshot, origin_kind,
      previous_value_snapshot, previous_status_snapshot, previous_origin_kind, previous_source
    )
    SELECT tenant_id, id, chat_id, user_id, NULL, 'UPDATE', 'legacy_project_quarantine',
           value, 'pending_review', 'assistant',
           value, status, origin_kind, source
    FROM memory_facts
    WHERE ${projectQuarantineWhere}
  `);
  db.exec(`
    UPDATE memory_facts
    SET status = 'pending_review', origin_kind = 'assistant'
    WHERE ${projectQuarantineWhere}
  `);
  if (quarantinedTenants.length > 0 && db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_vector_index_state'
  `).get()) {
    const placeholders = quarantinedTenants.map(() => '?').join(',');
    db.prepare(`DELETE FROM memory_vector_index_state WHERE tenant_id IN (${placeholders})`)
      .run(...quarantinedTenants.map(row => row.tenant_id));
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_memory_facts_status ON memory_facts(tenant_id, status, chat_id)');

  // Add tool_outcomes table for feedback loop
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      chat_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      iteration INTEGER NOT NULL,
      tool_name TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome IN ('success', 'error')),
      error_summary TEXT,
      duration_ms INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_tool_outcomes_tenant_tool ON tool_outcomes(tenant_id, tool_name, outcome)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_tool_outcomes_chat_turn ON tool_outcomes(chat_id, turn_id)');

  // Route reminders back through their originating channel instead of
  // hardwiring delivery to Telegram.
  try {
    db.exec('ALTER TABLE reminders ADD COLUMN channel_type TEXT');
  } catch {
    // Column already exists — ignore
  }

  // Add effectiveness tracking columns to lessons table
  try {
    db.exec('ALTER TABLE lessons ADD COLUMN effectiveness_score REAL NOT NULL DEFAULT 0.0');
  } catch {
    // Column already exists — ignore
  }
  try {
    db.exec('ALTER TABLE lessons ADD COLUMN last_applied_at TEXT');
  } catch {
    // Column already exists — ignore
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_lessons_effectiveness ON lessons(effectiveness_score)');

  // Add goals table for persistent goal tracking with autonomy budget
  db.exec(`
    CREATE TABLE IF NOT EXISTS goals (
      id TEXT NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      chat_id TEXT,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_progress','completed','failed','abandoned')),
      priority INTEGER NOT NULL DEFAULT 0,
      progress INTEGER NOT NULL DEFAULT 0,
      autonomy_budget INTEGER NOT NULL DEFAULT 1,
      success_count INTEGER NOT NULL DEFAULT 0,
      failure_count INTEGER NOT NULL DEFAULT 0,
      evidence TEXT NOT NULL DEFAULT '[]',
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (tenant_id, id)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(tenant_id, status)');

  // Add recall tracking columns to memory_facts
  try {
    db.exec('ALTER TABLE memory_facts ADD COLUMN recall_count INTEGER NOT NULL DEFAULT 0');
  } catch {
    // Column already exists — ignore
  }
  try {
    db.exec('ALTER TABLE memory_facts ADD COLUMN last_recalled_at TEXT');
  } catch {
    // Column already exists — ignore
  }
  try {
    db.exec('ALTER TABLE memory_facts ADD COLUMN salience_score REAL NOT NULL DEFAULT 0.5');
  } catch {
    // Column already exists — ignore
  }
  db.exec(`
    UPDATE memory_facts
    SET salience_score = CASE
      WHEN category = 'lesson' THEN MAX(salience_score, 0.8)
      WHEN key LIKE 'correction%' THEN MAX(salience_score, 0.95)
      ELSE salience_score
    END
    WHERE salience_score IS NOT NULL
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_memory_facts_recall ON memory_facts(recall_count, last_recalled_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_memory_facts_salience ON memory_facts(tenant_id, chat_id, salience_score DESC)');
  db.exec("CREATE INDEX IF NOT EXISTS idx_external_worker_jobs_chat ON external_worker_jobs(tenant_id, json_extract(metadata, '$.chat_id'), updated_at DESC)");

  // Observability trace tables (turn-level traces + tool-level spans)
  db.exec(`
    CREATE TABLE IF NOT EXISTS turn_traces (
      trace_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      turn_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      model TEXT NOT NULL,
      provider TEXT,
      status TEXT NOT NULL DEFAULT 'failed' CHECK(status IN ('success', 'failed', 'timeout', 'cancelled')),
      verify_status TEXT NOT NULL DEFAULT 'not_required' CHECK(verify_status IN ('not_required', 'pending', 'passed', 'failed')),
      verify_summary TEXT NOT NULL DEFAULT '',
      failure_category TEXT,
      tool_call_count INTEGER NOT NULL DEFAULT 0,
      tool_failure_count INTEGER NOT NULL DEFAULT 0,
      llm_input_tokens INTEGER NOT NULL DEFAULT 0,
      llm_output_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT
    )
  `);
  const turnTraceColumns = db.prepare('PRAGMA table_info(turn_traces)').all() as Array<{ name: string }>;
  if (!turnTraceColumns.some(column => column.name === 'verify_status')) {
    db.exec("ALTER TABLE turn_traces ADD COLUMN verify_status TEXT NOT NULL DEFAULT 'not_required' CHECK(verify_status IN ('not_required', 'pending', 'passed', 'failed'))");
  }
  if (!turnTraceColumns.some(column => column.name === 'verify_summary')) {
    db.exec("ALTER TABLE turn_traces ADD COLUMN verify_summary TEXT NOT NULL DEFAULT ''");
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_turn_traces_tenant_started ON turn_traces(tenant_id, started_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_turn_traces_tenant_model_started ON turn_traces(tenant_id, model, started_at DESC)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_spans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      turn_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      iteration INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK(status IN ('success', 'error')),
      duration_ms INTEGER NOT NULL DEFAULT 0,
      error_category TEXT,
      error_message TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT,
      FOREIGN KEY(trace_id) REFERENCES turn_traces(trace_id) ON DELETE CASCADE
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_tool_spans_trace ON tool_spans(trace_id, started_at ASC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_tool_spans_tenant_started ON tool_spans(tenant_id, started_at DESC)');

  // Prompt snapshots for observability
  db.exec(`
    CREATE TABLE IF NOT EXISTS prompt_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      chat_id TEXT NOT NULL,
      model TEXT NOT NULL,
      snapshot JSON NOT NULL,
      captured_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(trace_id) REFERENCES turn_traces(trace_id) ON DELETE CASCADE
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_prompt_snapshots_trace ON prompt_snapshots(trace_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_prompt_snapshots_tenant ON prompt_snapshots(tenant_id, captured_at DESC)');

  // Enterprise identity local auth columns on users.
  try {
    db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT');
  } catch {
    // Column already exists — ignore
  }
  try {
    db.exec("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'disabled'))");
  } catch {
    // Column already exists — ignore
  }
  try {
    db.exec('ALTER TABLE users ADD COLUMN allowed_models TEXT');
  } catch {
    // Column already exists — ignore
  }
  db.exec("UPDATE users SET status = 'active' WHERE status IS NULL OR status = ''");

  // Audit log for security-sensitive operations (#228)
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      tenant_id TEXT NOT NULL DEFAULT 'default',
      user_id TEXT,
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT,
      details TEXT,
      ip_address TEXT,
      user_agent TEXT,
      outcome TEXT NOT NULL DEFAULT 'success'
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_audit_log_tenant ON audit_log(tenant_id, timestamp)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action, timestamp)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id, timestamp)');

  // Session digests for episodic memory
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_digests (
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
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tenant_id, session_id)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_session_digests_user ON session_digests(tenant_id, user_id, created_at DESC)');

  // JWT token revocation blacklist
  db.exec(`
    CREATE TABLE IF NOT EXISTS revoked_tokens (
      jti TEXT PRIMARY KEY,
      revoked_at TEXT NOT NULL DEFAULT (datetime('now')),
      reason TEXT,
      expires_at TEXT NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expires ON revoked_tokens(expires_at)');
}

// Allow running directly: node dist/store/migrate.js
if (process.argv[1] && process.argv[1].includes('migrate')) {
  runMigrations();
  console.log('Migrations completed successfully.');
}
