import { getDb } from '../store/db.js';
import type {
  ContextSlotBreakdown,
} from '../memory/context-builder.js';
import type { TurnTraceVerifyStatus } from './telemetry.js';
import type { CompletionGateDecision } from '../core/completion-gates.js';
import type { TaskToolProfile } from '../tools/tool-shaping.js';
import type { RuntimeAdmission } from '../core/durable-plan-admission.js';

export type PromptSnapshotAdmissionStatus = 'not_required' | 'required' | 'accepted' | 'blocked';

export interface PromptSnapshotSlot {
  name: string;
  priority: number;
  tokenCap: number;
  rawTokens: number;
  usedTokens: number;
  included: boolean;
  itemCount: number;
  fallbackApplied: string;
}

export interface PromptSnapshotToolEntry {
  name: string;
  source: 'builtin' | 'dynamic' | 'skill';
}

export interface PromptSnapshotVerifierState {
  verify_status: TurnTraceVerifyStatus;
  verify_required: boolean;
  summary: string;
  missing_actions: string[];
  failure_reasons: string[];
}

export interface PromptSnapshot {
  version: 1;
  trace_id: string;
  tenant_id: string;
  chat_id: string;
  model: string;
  captured_at: string;
  context: {
    total_budget: number;
    system_slot_budget: number;
    history_token_budget: number;
    slots: PromptSnapshotSlot[];
  };
  tools: PromptSnapshotToolEntry[];
  verifier: PromptSnapshotVerifierState;
  runtime_meta: {
    message_count: number;
    system_message_count: number;
    prompt_tokens_estimate: number;
    tool_schema_tokens_estimate: number;
    exposed_tool_count: number;
    task_profile: TaskToolProfile;
    runtime_admission: RuntimeAdmission | null;
    admission_status: PromptSnapshotAdmissionStatus;
  };
}

export interface CapturePromptSnapshotInput {
  trace_id: string;
  tenant_id: string;
  chat_id: string;
  model: string;
  slotBreakdown: ContextSlotBreakdown[];
  totalBudget: number;
  systemSlotBudget: number;
  historyTokenBudget: number;
  tools: PromptSnapshotToolEntry[];
  gateDecision: CompletionGateDecision | null;
  messageCount: number;
  systemMessageCount: number;
  promptTokensEstimate?: number;
  toolSchemaTokensEstimate?: number;
  taskProfile?: TaskToolProfile;
  runtimeAdmission?: RuntimeAdmission;
}

function slotToSnapshot(slot: ContextSlotBreakdown): PromptSnapshotSlot {
  return {
    name: slot.name,
    priority: slot.priority,
    tokenCap: slot.tokenCap,
    rawTokens: slot.rawTokens,
    usedTokens: slot.usedTokens,
    included: slot.included,
    itemCount: slot.itemCount,
    fallbackApplied: slot.fallbackApplied,
  };
}

function gateToVerifier(decision: CompletionGateDecision | null): PromptSnapshotVerifierState {
  if (!decision) {
    return {
      verify_status: 'not_required',
      verify_required: false,
      summary: 'No completion gate evaluated.',
      missing_actions: [],
      failure_reasons: [],
    };
  }
  return {
    verify_status: decision.status === 'not_required' ? 'not_required'
      : decision.status === 'passed' ? 'passed'
        : decision.status === 'failed' ? 'failed'
          : 'pending',
    verify_required: decision.verify_required,
    summary: decision.summary,
    missing_actions: decision.missing_actions,
    failure_reasons: decision.failure_reasons,
  };
}

const REDACT_PATTERNS = [
  /sk-[a-zA-Z0-9_-]{20,}/g,
  /Bearer [a-zA-Z0-9._-]+/g,
  /password\s*[:=]\s*\S+/gi,
  /secret\s*[:=]\s*\S+/gi,
];

function redactString(value: string): string {
  let result = value;
  for (const pattern of REDACT_PATTERNS) {
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

export function redactSnapshot(snapshot: PromptSnapshot): PromptSnapshot {
  return {
    ...snapshot,
    verifier: {
      ...snapshot.verifier,
      summary: redactString(snapshot.verifier.summary),
      missing_actions: snapshot.verifier.missing_actions.map(redactString),
      failure_reasons: snapshot.verifier.failure_reasons.map(redactString),
    },
  };
}

export function capturePromptSnapshot(input: CapturePromptSnapshotInput): PromptSnapshot {
  return {
    version: 1,
    trace_id: input.trace_id,
    tenant_id: input.tenant_id,
    chat_id: input.chat_id,
    model: input.model,
    captured_at: new Date().toISOString(),
    context: {
      total_budget: input.totalBudget,
      system_slot_budget: input.systemSlotBudget,
      history_token_budget: input.historyTokenBudget,
      slots: input.slotBreakdown.map(slotToSnapshot),
    },
    tools: input.tools,
    verifier: gateToVerifier(input.gateDecision),
    runtime_meta: {
      message_count: input.messageCount,
      system_message_count: input.systemMessageCount,
      prompt_tokens_estimate: input.promptTokensEstimate ?? 0,
      tool_schema_tokens_estimate: input.toolSchemaTokensEstimate ?? 0,
      exposed_tool_count: input.tools.length,
      task_profile: input.taskProfile ?? 'general',
      runtime_admission: input.runtimeAdmission ?? null,
      admission_status: input.runtimeAdmission ? 'required' : 'not_required',
    },
  };
}

let tableEnsured = false;

// Lazy table init — canonical schema lives in src/store/schema.sql and src/store/migrate.ts.
// This is a fallback for standalone/test use. Keep in sync with those files.
function ensureTable(): void {
  if (tableEnsured) return;
  const db = getDb();
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
  tableEnsured = true;
}

export function resetPromptSnapshotTableFlag(): void {
  tableEnsured = false;
}

export function persistPromptSnapshot(snapshot: PromptSnapshot): void {
  ensureTable();
  const db = getDb();
  const redacted = redactSnapshot(snapshot);
  db.prepare(`
    INSERT INTO prompt_snapshots (trace_id, tenant_id, chat_id, model, snapshot, captured_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    redacted.trace_id,
    redacted.tenant_id,
    redacted.chat_id,
    redacted.model,
    JSON.stringify(redacted),
    redacted.captured_at,
  );
}

export function updatePromptSnapshotVerifier(
  traceId: string,
  tenantId: string,
  decision: CompletionGateDecision,
): void {
  ensureTable();
  const db = getDb();
  const row = db.prepare(`
    SELECT id, snapshot FROM prompt_snapshots
    WHERE trace_id = ? AND tenant_id = ?
    ORDER BY id DESC LIMIT 1
  `).get(traceId, tenantId) as { id: number; snapshot: string } | undefined;
  if (!row) return;
  const snapshot = JSON.parse(row.snapshot) as PromptSnapshot;
  snapshot.verifier = gateToVerifier(decision);
  db.prepare('UPDATE prompt_snapshots SET snapshot = ? WHERE id = ?')
    .run(JSON.stringify(redactSnapshot(snapshot)), row.id);
}

export function updatePromptSnapshotAdmission(
  traceId: string,
  tenantId: string,
  status: 'accepted' | 'blocked',
): void {
  ensureTable();
  const db = getDb();
  const row = db.prepare(`
    SELECT id, snapshot FROM prompt_snapshots
    WHERE trace_id = ? AND tenant_id = ?
    ORDER BY id DESC LIMIT 1
  `).get(traceId, tenantId) as { id: number; snapshot: string } | undefined;
  if (!row) return;
  const snapshot = JSON.parse(row.snapshot) as PromptSnapshot;
  snapshot.runtime_meta.admission_status = status;
  db.prepare('UPDATE prompt_snapshots SET snapshot = ? WHERE id = ?')
    .run(JSON.stringify(redactSnapshot(snapshot)), row.id);
}

export function getPromptSnapshot(traceId: string, tenantId = 'default'): PromptSnapshot | null {
  ensureTable();
  const db = getDb();
  const row = db.prepare(`
    SELECT snapshot FROM prompt_snapshots
    WHERE trace_id = ? AND tenant_id = ?
    ORDER BY id DESC LIMIT 1
  `).get(traceId, tenantId) as { snapshot: string } | undefined;
  if (!row) return null;
  return JSON.parse(row.snapshot) as PromptSnapshot;
}

export function getRecentPromptSnapshots(tenantId = 'default', limit = 20): PromptSnapshot[] {
  ensureTable();
  const db = getDb();
  const rows = db.prepare(`
    SELECT snapshot FROM prompt_snapshots
    WHERE tenant_id = ?
    ORDER BY captured_at DESC, id DESC
    LIMIT ?
  `).all(tenantId, limit) as Array<{ snapshot: string }>;
  return rows.map(row => JSON.parse(row.snapshot) as PromptSnapshot);
}

const DEFAULT_MAX_SNAPSHOT_AGE_DAYS = 30;

/**
 * Remove prompt snapshots older than `maxAgeDays` for a tenant.
 * Returns the number of rows deleted.
 */
export function pruneOldSnapshots(tenantId = 'default', maxAgeDays = DEFAULT_MAX_SNAPSHOT_AGE_DAYS): number {
  ensureTable();
  const db = getDb();
  const result = db.prepare(`
    DELETE FROM prompt_snapshots
    WHERE tenant_id = ? AND captured_at < datetime('now', ? || ' days')
  `).run(tenantId, `-${maxAgeDays}`);
  return result.changes;
}
