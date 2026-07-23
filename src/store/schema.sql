-- MOZI Store Schema
-- All tables include tenant_id for multi-tenancy support

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  parent_task_id TEXT,
  title TEXT NOT NULL,
  objective TEXT,
  done_criteria TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  assigned_agent TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  tags TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS task_dependencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  task_id TEXT NOT NULL,
  depends_on_task_id TEXT NOT NULL,
  UNIQUE(task_id, depends_on_task_id)
);

CREATE TABLE IF NOT EXISTS task_attempts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  task_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  result_status TEXT,
  result_payload JSON,
  checkpoints TEXT
);

CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  task_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  files_changed JSON,
  db_mutations JSON,
  agent_context_summary TEXT,
  rollback_commands TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS message_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  channel TEXT NOT NULL,
  sender TEXT NOT NULL,
  receiver TEXT NOT NULL,
  payload JSON NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  processed_at TEXT,
  ttl_seconds INTEGER
);

CREATE INDEX IF NOT EXISTS idx_queue_pending
  ON message_queue(channel, receiver, status, priority, created_at);

CREATE TABLE IF NOT EXISTS event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  payload JSON NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_event_entity
  ON event_log(entity_type, entity_id, created_at);

CREATE TABLE IF NOT EXISTS runtime_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  state_kind TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  payload JSON NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, state_kind, scope_type, scope_id)
);

CREATE TABLE IF NOT EXISTS task_templates (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  instructions TEXT NOT NULL,
  output_format TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 1 CHECK(pinned IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, user_id, id)
);

CREATE INDEX IF NOT EXISTS idx_task_templates_owner_order
  ON task_templates(tenant_id, user_id, sort_order ASC, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_runtime_state_updated
  ON runtime_state(tenant_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS external_worker_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  agent_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  transport TEXT NOT NULL,
  status TEXT NOT NULL,
  failure_category TEXT,
  runtime_label TEXT,
  active_run_id TEXT,
  last_error TEXT,
  task_spec JSON NOT NULL,
  artifact_refs JSON NOT NULL,
  result_envelope JSON,
  verify_report JSON,
  metadata JSON NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_external_worker_jobs_tenant_status
  ON external_worker_jobs(tenant_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_external_worker_jobs_task
  ON external_worker_jobs(tenant_id, task_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_external_worker_jobs_chat
  ON external_worker_jobs(tenant_id, json_extract(metadata, '$.chat_id'), updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_registry (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('preset', 'dynamic')),
  system_prompt TEXT,
  tools_allowed JSON DEFAULT '[]',
  permission_level TEXT DEFAULT 'L0_READ_ONLY',
  config JSON,
  status TEXT NOT NULL DEFAULT 'active',
  spawn_count INTEGER NOT NULL DEFAULT 0,
  success_rate REAL NOT NULL DEFAULT 0.0,
  avg_token_cost REAL NOT NULL DEFAULT 0.0,
  evolution_score REAL NOT NULL DEFAULT 0.0,
  created_by TEXT DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS skill_versions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  skill_id TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  skill_md TEXT,
  scripts JSON,
  input_schema JSON,
  output_schema JSON,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS traces (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  task_id TEXT,
  agent_id TEXT,
  event_type TEXT,
  data JSON,
  timestamp TEXT NOT NULL
);

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
);

CREATE INDEX IF NOT EXISTS idx_turn_traces_tenant_started
  ON turn_traces(tenant_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_turn_traces_tenant_model_started
  ON turn_traces(tenant_id, model, started_at DESC);

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
);

CREATE INDEX IF NOT EXISTS idx_tool_spans_trace
  ON tool_spans(trace_id, started_at ASC);

CREATE INDEX IF NOT EXISTS idx_tool_spans_tenant_started
  ON tool_spans(tenant_id, started_at DESC);

CREATE TABLE IF NOT EXISTS prompt_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  chat_id TEXT NOT NULL,
  model TEXT NOT NULL,
  snapshot JSON NOT NULL,
  captured_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(trace_id) REFERENCES turn_traces(trace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_prompt_snapshots_trace
  ON prompt_snapshots(trace_id);

CREATE INDEX IF NOT EXISTS idx_prompt_snapshots_tenant
  ON prompt_snapshots(tenant_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS alert_rules (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  actions TEXT NOT NULL DEFAULT '["log"]',
  cooldown_seconds INTEGER NOT NULL DEFAULT 300,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS alert_history (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  rule_id TEXT NOT NULL,
  rule_name TEXT NOT NULL,
  severity TEXT NOT NULL,
  actions TEXT NOT NULL,
  context JSON NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tenant_quotas (
  tenant_id TEXT PRIMARY KEY,
  daily_token_limit INTEGER,
  monthly_token_limit INTEGER,
  max_tokens_per_task INTEGER,
  max_parallel_agents INTEGER DEFAULT 5,
  max_active_tasks INTEGER DEFAULT 20,
  max_storage_mb INTEGER DEFAULT 1024,
  max_skills INTEGER DEFAULT 50,
  allowed_models TEXT,
  brain_model TEXT
);

-- Billing records for per-tenant usage tracking
CREATE TABLE IF NOT EXISTS billing_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  record_type TEXT NOT NULL CHECK(record_type IN ('llm_call', 'tool_call')),
  user_id TEXT,
  provider TEXT,
  model TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  cost_usd REAL DEFAULT 0.0,
  input_cost_per_million REAL,
  output_cost_per_million REAL,
  cache_read_cost_per_million REAL,
  cache_write_cost_per_million REAL,
  pricing_source TEXT NOT NULL DEFAULT 'unknown',
  usage_status TEXT NOT NULL DEFAULT 'legacy_unverified',
  price_version TEXT,
  currency TEXT NOT NULL DEFAULT 'usd',
  outcome TEXT NOT NULL DEFAULT 'success',
  failure_category TEXT,
  tool TEXT,
  duration_ms INTEGER DEFAULT 0,
  task_id TEXT,
  agent_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_billing_tenant_date
  ON billing_records(tenant_id, created_at);

CREATE INDEX IF NOT EXISTS idx_billing_tenant_type
  ON billing_records(tenant_id, record_type, created_at);

CREATE INDEX IF NOT EXISTS idx_billing_tenant_user_date
  ON billing_records(tenant_id, user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_billing_tenant_model_date
  ON billing_records(tenant_id, provider, model, created_at);

-- Legacy provider reconciliation storage retained for database compatibility.
-- The product no longer reads or writes these tables; spend is estimated locally
-- from observed Token categories and immutable model-price snapshots.
CREATE TABLE IF NOT EXISTS provider_cost_reconciliations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  provider TEXT NOT NULL,
  day TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  project_id TEXT NOT NULL DEFAULT '',
  line_item TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, provider, day, project_id, line_item)
);

CREATE INDEX IF NOT EXISTS idx_provider_cost_reconciliation_tenant_day
  ON provider_cost_reconciliations(tenant_id, day, provider);

CREATE TABLE IF NOT EXISTS provider_usage_reconciliations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  provider TEXT NOT NULL,
  day TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  project_id TEXT NOT NULL DEFAULT '',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, provider, day, model, project_id)
);

CREATE INDEX IF NOT EXISTS idx_provider_usage_reconciliation_tenant_day
  ON provider_usage_reconciliations(tenant_id, day, provider);

-- RBAC role assignments
CREATE TABLE IF NOT EXISTS role_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin', 'operator', 'viewer')),
  assigned_by TEXT DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_role_tenant_user
  ON role_assignments(tenant_id, user_id);

-- API keys for enterprise auth fallback
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  key_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  user_id TEXT NOT NULL,
  roles TEXT NOT NULL DEFAULT '["viewer"]',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'revoked')),
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_api_keys_hash
  ON api_keys(key_hash);

CREATE TABLE IF NOT EXISTS allowed_users (
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  username TEXT,
  role TEXT NOT NULL DEFAULT 'owner',
  paired_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_allowed_users_tenant_role
  ON allowed_users(tenant_id, role);

CREATE TABLE IF NOT EXISTS pairing_tokens (
  tenant_id TEXT NOT NULL DEFAULT 'default',
  token_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, token_hash)
);

CREATE INDEX IF NOT EXISTS idx_pairing_tokens_tenant_active
  ON pairing_tokens(tenant_id, used, expires_at);

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

CREATE INDEX IF NOT EXISTS idx_pairing_requests_tenant_pending
  ON pairing_requests(tenant_id, approved, expires_at);

-- Conversation history for persistent memory
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  chat_id TEXT NOT NULL,
  session_id TEXT,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool')),
  content TEXT NOT NULL,
  model TEXT,
  tokens_used INTEGER DEFAULT 0,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_conv_chat
  ON conversations(chat_id, created_at DESC);
-- idx_conv_session is created in migrate.ts after ALTER TABLE adds session_id

-- Durable, session-scoped projection of reduced conversation context. Raw
-- conversations remain immutable and are always the recovery source.
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
);

CREATE INDEX IF NOT EXISTS idx_context_checkpoints_session
  ON context_checkpoints(tenant_id, session_id, status, source_message_id DESC);

CREATE TABLE IF NOT EXISTS artifact_versions (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  version_number INTEGER NOT NULL,
  content TEXT,
  persisted_path TEXT,
  created_at INTEGER,
  change_description TEXT
);

-- Lookups are always tenant-scoped: `update_artifact` takes an artifact_id
-- straight from the model, so an unscoped read here would resolve another
-- tenant's version record.
CREATE INDEX IF NOT EXISTS idx_artifact_versions_tenant_artifact
  ON artifact_versions(tenant_id, artifact_id, version_number DESC);

-- Stable identity for filesystem deliverables. Version snapshots and rename /
-- move detection intentionally belong to later issues; identity here is the
-- tenant-scoped absolute path only.
CREATE TABLE IF NOT EXISTS deliverables (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  current_size INTEGER NOT NULL,
  current_mtime_ms INTEGER NOT NULL,
  current_hash TEXT,
  version_count INTEGER NOT NULL DEFAULT 1,
  first_session_id TEXT,
  last_session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(tenant_id, path)
);

CREATE TABLE IF NOT EXISTS deliverable_versions (
  id TEXT PRIMARY KEY,
  deliverable_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  version INTEGER NOT NULL,
  snapshot_path TEXT NOT NULL,
  size INTEGER NOT NULL,
  hash TEXT,
  session_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(deliverable_id, version)
);

CREATE TABLE IF NOT EXISTS session_deliverable_bindings (
  session_id TEXT NOT NULL,
  deliverable_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, deliverable_id)
);

-- Lossless UI timeline for restoring the exact session workbench state.
-- Conversations remain the model/memory history; this table stores what the
-- Web UI rendered during execution: messages, tool/task progress, approvals,
-- and artifacts.
CREATE TABLE IF NOT EXISTS session_timeline_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  session_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  turn_id TEXT,
  -- Durable per-turn monotonic sequence assigned at the server-owned choke point
  -- (saveTimelineItem). NULL for legacy rows and rows written outside a turn.
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

CREATE INDEX IF NOT EXISTS idx_session_timeline_order
  ON session_timeline_events(tenant_id, session_id, timestamp_ms ASC, id ASC);

CREATE INDEX IF NOT EXISTS idx_session_timeline_turn
  ON session_timeline_events(tenant_id, session_id, turn_id);
CREATE INDEX IF NOT EXISTS idx_session_timeline_turn_seq
  ON session_timeline_events(tenant_id, session_id, turn_id, turn_seq ASC);
CREATE INDEX IF NOT EXISTS idx_session_timeline_conversation
  ON session_timeline_events(tenant_id, session_id, conversation_id);

-- Server-authoritative Turn Envelope lifecycle (Issue #627). One row per user
-- turn, recording origin, current status, the per-turn sequence high-water mark,
-- and start/end times. This is the durable truth for turn grouping and terminal
-- state; the timeline events reference it by turn_id. Additive: legacy sessions
-- simply have no rows here and remain fully readable.
CREATE TABLE IF NOT EXISTS session_turns (
  tenant_id TEXT NOT NULL DEFAULT 'default',
  session_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'active',
  seq_high_water INTEGER NOT NULL DEFAULT 0,
  -- Presentation locale carried on the authoritative path (Issue #628);
  -- NULL for turns with no reliable language signal.
  locale TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, session_id, turn_id)
);

CREATE INDEX IF NOT EXISTS idx_session_turns_order
  ON session_turns(tenant_id, session_id, started_at ASC, turn_id ASC);

-- Long-term memory: stored facts (preferences, decisions, lessons)
CREATE TABLE IF NOT EXISTS memory_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  chat_id TEXT NOT NULL,
  user_id TEXT,
  category TEXT NOT NULL CHECK(category IN ('preference', 'fact', 'decision', 'lesson')),
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  salience_score REAL NOT NULL DEFAULT 0.5,
  source TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'pending_review', 'disputed', 'retracted')),
  origin_kind TEXT NOT NULL DEFAULT 'legacy' CHECK(origin_kind IN ('user', 'tool', 'assistant', 'manual', 'legacy')),
  recall_count INTEGER NOT NULL DEFAULT 0,
  last_recalled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, chat_id, category, key)
);

CREATE INDEX IF NOT EXISTS idx_memory_facts_chat
  ON memory_facts(tenant_id, chat_id, category);
-- idx_memory_facts_salience is created in migrate.ts after ALTER TABLE adds salience_score
-- idx_memory_facts_recall is created in migrate.ts after ALTER TABLE adds recall_count
-- idx_memory_facts_user is created in migrate.ts after ALTER TABLE adds user_id

-- Durable evidence for each turn that created, reinforced, or updated a memory.
-- The unique turn/fact pair prevents the explicit remember tool and background
-- auto-extraction from counting the same user statement twice.
CREATE TABLE IF NOT EXISTS memory_fact_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  fact_id INTEGER NOT NULL,
  chat_id TEXT NOT NULL,
  user_id TEXT,
  turn_id TEXT,
  action TEXT NOT NULL CHECK(action IN ('ADD', 'REINFORCE', 'UPDATE')),
  source TEXT NOT NULL,
  value_snapshot TEXT,
  status_snapshot TEXT CHECK(status_snapshot IS NULL OR status_snapshot IN ('active', 'pending_review', 'disputed', 'retracted')),
  origin_kind TEXT CHECK(origin_kind IS NULL OR origin_kind IN ('user', 'tool', 'assistant', 'manual', 'legacy')),
  previous_value_snapshot TEXT,
  previous_status_snapshot TEXT CHECK(previous_status_snapshot IS NULL OR previous_status_snapshot IN ('active', 'pending_review', 'disputed', 'retracted')),
  previous_origin_kind TEXT CHECK(previous_origin_kind IS NULL OR previous_origin_kind IN ('user', 'tool', 'assistant', 'manual', 'legacy')),
  previous_source TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(fact_id) REFERENCES memory_facts(id) ON DELETE CASCADE,
  UNIQUE(tenant_id, fact_id, turn_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_fact_evidence_turn
  ON memory_fact_evidence(tenant_id, turn_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_memory_fact_evidence_fact
  ON memory_fact_evidence(tenant_id, fact_id, created_at DESC);

-- Proactive reminders
CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  chat_id TEXT NOT NULL,
  user_id TEXT,
  session_id TEXT,
  channel_type TEXT,
  message TEXT NOT NULL,
  fire_at DATETIME NOT NULL,
  fired BOOLEAN NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  next_attempt_at INTEGER,
  last_attempt_at DATETIME,
  last_error TEXT,
  fired_at DATETIME,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_reminders_due
  ON reminders(tenant_id, status, fire_at, next_attempt_at);

-- Persistent scheduled jobs. A trigger creates a cron_task_runs row and a
-- linked background task; enqueue is never reported as execution success.
CREATE TABLE IF NOT EXISTS cron_tasks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  chat_id TEXT NOT NULL,
  user_id TEXT,
  session_id TEXT,
  channel_type TEXT,
  permission_level TEXT,
  schedule_kind TEXT NOT NULL DEFAULT 'cron',
  schedule_value TEXT NOT NULL,
  timezone TEXT,
  handler_type TEXT NOT NULL,
  handler_params TEXT,
  description TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  delete_after_run INTEGER NOT NULL DEFAULT 0,
  last_run_at DATETIME,
  next_run_at DATETIME,
  run_count INTEGER NOT NULL DEFAULT 0,
  last_status TEXT,
  last_error TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_cron_tasks_tenant
  ON cron_tasks(tenant_id, enabled, next_run_at);

CREATE TABLE IF NOT EXISTS cron_task_runs (
  id TEXT PRIMARY KEY,
  cron_task_id TEXT,
  background_task_id INTEGER,
  session_id TEXT,
  trigger_origin TEXT NOT NULL DEFAULT 'schedule',
  tenant_id TEXT NOT NULL DEFAULT 'default',
  scheduled_for DATETIME NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  result TEXT,
  error TEXT,
  delivery_status TEXT NOT NULL DEFAULT 'pending',
  delivery_error TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at DATETIME,
  completed_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_cron_task_runs_task
  ON cron_task_runs(tenant_id, cron_task_id, created_at DESC);

-- Background tasks for autonomous follow-up and resumable objectives
CREATE TABLE IF NOT EXISTS background_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  chat_id TEXT NOT NULL,
  user_id TEXT,
  session_id TEXT,
  channel_type TEXT,
  permission_level TEXT,
  source_cron_task_id TEXT,
  cron_run_id TEXT,
  objective TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  handler_type TEXT,
  handler_params TEXT,
  running_since DATETIME,
  last_error TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  retry_after INTEGER,
  max_retries INTEGER NOT NULL DEFAULT 3,
  timeout_ms INTEGER NOT NULL DEFAULT 300000,
  delivery_status TEXT NOT NULL DEFAULT 'none',
  delivery_attempts INTEGER NOT NULL DEFAULT 0,
  delivery_after INTEGER,
  delivery_error TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_background_tasks_tenant_status
  ON background_tasks(tenant_id, status, created_at DESC);

-- Self-learning lessons memory
CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  trigger_pattern TEXT NOT NULL,
  lesson TEXT NOT NULL,
  source TEXT,
  times_applied INTEGER NOT NULL DEFAULT 0,
  effectiveness_score REAL NOT NULL DEFAULT 0.0,
  last_applied_at TEXT,
  created_at DATETIME NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_lessons_tenant_created
  ON lessons(tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_lessons_tenant_trigger
  ON lessons(tenant_id, trigger_pattern);

-- idx_lessons_effectiveness is created in migrate.ts after ALTER TABLE adds effectiveness_score

-- Tool execution outcome tracking for feedback loop
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
);
CREATE INDEX IF NOT EXISTS idx_tool_outcomes_tenant_tool ON tool_outcomes(tenant_id, tool_name, outcome);
CREATE INDEX IF NOT EXISTS idx_tool_outcomes_chat_turn ON tool_outcomes(chat_id, turn_id);

CREATE TABLE IF NOT EXISTS dynamic_tools (
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
);

CREATE INDEX IF NOT EXISTS idx_dynamic_tools_status
  ON dynamic_tools(tenant_id, status, last_used_at DESC);

-- Sessions (conversation threads)
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT 'New Chat',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  archived INTEGER NOT NULL DEFAULT 0,
  permission_level TEXT NOT NULL DEFAULT 'L3_FULL_ACCESS',
  workspace_root_id TEXT,
  workspace_context JSON,
  project_root_id TEXT,
  project_context JSON,
  execution_root_id TEXT,
  execution_context JSON,
  scope_grants JSON
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(tenant_id, user_id, archived);

-- Persistent goals with autonomy budget
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
);
CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(tenant_id, status);

-- Shared context blackboard for inter-agent context sharing
CREATE TABLE IF NOT EXISTS blackboard (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  scope TEXT NOT NULL DEFAULT 'global',
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  written_by TEXT,
  ttl_seconds INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, scope, key)
);

CREATE INDEX IF NOT EXISTS idx_blackboard_scope
  ON blackboard(tenant_id, scope, updated_at DESC);

-- Revoked JWT tokens (jti blacklist)
CREATE TABLE IF NOT EXISTS revoked_tokens (
  jti TEXT PRIMARY KEY,
  revoked_at TEXT NOT NULL DEFAULT (datetime('now')),
  reason TEXT,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expires ON revoked_tokens(expires_at);

-- Audit log for security-sensitive operations
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
);
CREATE INDEX IF NOT EXISTS idx_audit_log_tenant ON audit_log(tenant_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action, timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id, timestamp);

-- Session digests for episodic memory
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
);
CREATE INDEX IF NOT EXISTS idx_session_digests_user
  ON session_digests(tenant_id, user_id, created_at DESC);

-- ── Phase 2: Enterprise Auth (#230-#234) ──────────────────────────────────

-- #231 Users table — JIT-provisioned on first OAuth/SAML login
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  email TEXT NOT NULL,
  name TEXT,
  avatar_url TEXT,
  auth_provider TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  password_hash TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'disabled')),
  role TEXT NOT NULL DEFAULT 'viewer' CHECK(role IN ('admin', 'operator', 'viewer')),
  allowed_models TEXT,
  onboarding_completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT,
  UNIQUE(tenant_id, auth_provider, provider_id),
  UNIQUE(tenant_id, email)
);
CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(tenant_id, email);

-- #230 OAuth state — short-lived CSRF protection tokens
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  provider TEXT NOT NULL,
  redirect_uri TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oauth_states_expires ON oauth_states(expires_at);

-- #232 Refresh tokens — long-lived (7 days), rotated on use
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT,
  device_info TEXT
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON refresh_tokens(expires_at);

-- #233 User preferences — per-user key/value settings
CREATE TABLE IF NOT EXISTS user_preferences (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, user_id, key)
);
CREATE INDEX IF NOT EXISTS idx_user_prefs_user ON user_preferences(tenant_id, user_id);

-- ── Phase 3: Multi-tenant Data Isolation (#235-#239) ──────────────────────

-- #236 Tenant configuration overrides
CREATE TABLE IF NOT EXISTS tenant_configs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT,
  UNIQUE(tenant_id, key)
);
CREATE INDEX IF NOT EXISTS idx_tenant_configs_tenant ON tenant_configs(tenant_id);

-- #237 Tenant API keys (AES-256-GCM encrypted)
CREATE TABLE IF NOT EXISTS tenant_api_keys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  encrypted_key TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  key_hint TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT,
  UNIQUE(tenant_id, provider)
);
CREATE INDEX IF NOT EXISTS idx_tenant_api_keys_tenant ON tenant_api_keys(tenant_id);

-- #238 Quota limits and usage tracking
CREATE TABLE IF NOT EXISTS tenant_quota_limits (
  tenant_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  limit_value REAL NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(tenant_id, resource)
);
CREATE TABLE IF NOT EXISTS quota_usage (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  period TEXT NOT NULL,
  used REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, resource, period)
);
CREATE INDEX IF NOT EXISTS idx_quota_usage_tenant ON quota_usage(tenant_id, resource, period);
