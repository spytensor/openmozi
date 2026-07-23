import { z } from 'zod';
import type { ResultEnvelope } from '../agents/protocol.js';
import { getDb } from '../store/db.js';
import type { ManagedWorkerTaskInput } from './adapter.js';

const EXTERNAL_WORKER_SCHEMA_VERSION = 1 as const;

export const ExternalWorkerJobStatusSchema = z.enum([
  'queued',
  'launching',
  'running',
  'completed_pending_verify',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
]);
export type ExternalWorkerJobStatus = z.infer<typeof ExternalWorkerJobStatusSchema>;

export const ExternalWorkerFailureCategorySchema = z.enum([
  'launch_failed',
  'stalled',
  'timed_out',
  'result_missing',
  'verify_failed',
  'runtime_error',
]);
export type ExternalWorkerFailureCategory = z.infer<typeof ExternalWorkerFailureCategorySchema>;

export const ExternalWorkerArtifactRefsSchema = z.object({
  working_directory: z.string().nullable().default(null),
  task_spec_path: z.string().nullable().default(null),
  result_path: z.string().nullable().default(null),
  stdout_path: z.string().nullable().default(null),
  stderr_path: z.string().nullable().default(null),
});
export type ExternalWorkerArtifactRefs = z.infer<typeof ExternalWorkerArtifactRefsSchema>;

export const ExternalWorkerTaskSpecSchema = z.object({
  schema_version: z.literal(EXTERNAL_WORKER_SCHEMA_VERSION).default(EXTERNAL_WORKER_SCHEMA_VERSION),
  job_id: z.string(),
  task_id: z.string(),
  objective: z.string(),
  done_criteria: z.string().default(''),
  allowed_tools: z.array(z.string()).default([]),
  forbidden_paths: z.array(z.string()).default([]),
  timeout_ms: z.number().int().positive().nullable().default(null),
  working_directory: z.string().nullable().default(null),
  issue_id: z.string().nullable().default(null),
  allowed_scope: z.array(z.string()).default([]),
  non_goals: z.array(z.string()).default([]),
  acceptance_criteria: z.array(z.string()).default([]),
  required_tests: z.array(z.string()).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type ExternalWorkerTaskSpec = z.infer<typeof ExternalWorkerTaskSpecSchema>;

export const ExternalWorkerResultStatusSchema = z.enum([
  'completed',
  'failed',
  'partial',
  'cancelled',
]);
export type ExternalWorkerResultStatus = z.infer<typeof ExternalWorkerResultStatusSchema>;

export const ExternalWorkerTestStatusSchema = z.enum([
  'not_run',
  'passed',
  'failed',
  'partial',
]);
export type ExternalWorkerTestStatus = z.infer<typeof ExternalWorkerTestStatusSchema>;

export const ExternalWorkerResultEnvelopeSchema = z.object({
  schema_version: z.literal(EXTERNAL_WORKER_SCHEMA_VERSION).default(EXTERNAL_WORKER_SCHEMA_VERSION),
  job_id: z.string(),
  task_id: z.string(),
  adapter_id: z.string(),
  status: ExternalWorkerResultStatusSchema,
  summary: z.string().default(''),
  output: z.array(z.string()).default([]),
  changed_files: z.array(z.string()).default([]),
  tests_run: z.array(z.string()).default([]),
  test_status: ExternalWorkerTestStatusSchema.default('not_run'),
  artifacts: z.array(z.string()).default([]),
  blocker: z.string().nullable().default(null),
  failure_category: ExternalWorkerFailureCategorySchema.nullable().default(null),
  runtime_label: z.string().nullable().default(null),
  stdout_excerpt: z.string().nullable().default(null),
  stderr_excerpt: z.string().nullable().default(null),
  created_at: z.string(),
});
export type ExternalWorkerResultEnvelope = z.infer<typeof ExternalWorkerResultEnvelopeSchema>;

export const ExternalWorkerVerifyStatusSchema = z.enum([
  'pending',
  'passed',
  'failed',
  'skipped',
]);
export type ExternalWorkerVerifyStatus = z.infer<typeof ExternalWorkerVerifyStatusSchema>;

export const ExternalWorkerArtifactCheckStatusSchema = z.enum([
  'pending',
  'passed',
  'failed',
]);
export type ExternalWorkerArtifactCheckStatus = z.infer<typeof ExternalWorkerArtifactCheckStatusSchema>;

export const ExternalWorkerVerifyReportSchema = z.object({
  schema_version: z.literal(EXTERNAL_WORKER_SCHEMA_VERSION).default(EXTERNAL_WORKER_SCHEMA_VERSION),
  job_id: z.string(),
  status: ExternalWorkerVerifyStatusSchema,
  summary: z.string().default(''),
  acceptance_criteria_met: z.array(z.string()).default([]),
  acceptance_criteria_missing: z.array(z.string()).default([]),
  tests_checked: z.array(z.string()).default([]),
  test_status: ExternalWorkerTestStatusSchema.default('not_run'),
  artifact_check: ExternalWorkerArtifactCheckStatusSchema.default('pending'),
  diff_summary: z.string().default(''),
  notes: z.array(z.string()).default([]),
  created_at: z.string(),
});
export type ExternalWorkerVerifyReport = z.infer<typeof ExternalWorkerVerifyReportSchema>;

export const ExternalWorkerJobSchema = z.object({
  schema_version: z.literal(EXTERNAL_WORKER_SCHEMA_VERSION).default(EXTERNAL_WORKER_SCHEMA_VERSION),
  id: z.string(),
  tenant_id: z.string().default('default'),
  agent_id: z.string(),
  task_id: z.string(),
  adapter_id: z.string(),
  transport: z.string(),
  status: ExternalWorkerJobStatusSchema,
  failure_category: ExternalWorkerFailureCategorySchema.nullable().default(null),
  runtime_label: z.string().nullable().default(null),
  active_run_id: z.string().nullable().default(null),
  last_error: z.string().nullable().default(null),
  task_spec: ExternalWorkerTaskSpecSchema,
  artifact_refs: ExternalWorkerArtifactRefsSchema,
  result_envelope: ExternalWorkerResultEnvelopeSchema.nullable().default(null),
  verify_report: ExternalWorkerVerifyReportSchema.nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).default({}),
  created_at: z.string(),
  updated_at: z.string(),
  started_at: z.string().nullable().default(null),
  completed_at: z.string().nullable().default(null),
});
export type ExternalWorkerJob = z.infer<typeof ExternalWorkerJobSchema>;

export interface ExternalWorkerJobFilters {
  tenant_id?: string;
  statuses?: ExternalWorkerJobStatus[];
  adapter_id?: string;
  limit?: number;
}

interface ExternalWorkerJobRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  task_id: string;
  adapter_id: string;
  transport: string;
  status: string;
  failure_category: string | null;
  runtime_label: string | null;
  active_run_id: string | null;
  last_error: string | null;
  task_spec: string;
  artifact_refs: string;
  result_envelope: string | null;
  verify_report: string | null;
  metadata: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

const STATUS_TRANSITIONS: Record<ExternalWorkerJobStatus, ExternalWorkerJobStatus[]> = {
  queued: ['launching', 'failed', 'cancelled'],
  launching: ['running', 'failed', 'cancelled', 'timed_out'],
  running: ['completed_pending_verify', 'failed', 'cancelled', 'timed_out'],
  completed_pending_verify: ['succeeded', 'failed'],
  succeeded: [],
  failed: [],
  cancelled: [],
  timed_out: [],
};

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isTerminalJobStatus(status: ExternalWorkerJobStatus): boolean {
  return status === 'completed_pending_verify'
    || status === 'succeeded'
    || status === 'failed'
    || status === 'cancelled'
    || status === 'timed_out';
}

function parseRow(row: ExternalWorkerJobRow): ExternalWorkerJob {
  return ExternalWorkerJobSchema.parse({
    schema_version: EXTERNAL_WORKER_SCHEMA_VERSION,
    id: row.id,
    tenant_id: row.tenant_id,
    agent_id: row.agent_id,
    task_id: row.task_id,
    adapter_id: row.adapter_id,
    transport: row.transport,
    status: row.status,
    failure_category: row.failure_category,
    runtime_label: row.runtime_label,
    active_run_id: row.active_run_id,
    last_error: row.last_error,
    task_spec: JSON.parse(row.task_spec),
    artifact_refs: JSON.parse(row.artifact_refs),
    result_envelope: row.result_envelope ? JSON.parse(row.result_envelope) : null,
    verify_report: row.verify_report ? JSON.parse(row.verify_report) : null,
    metadata: JSON.parse(row.metadata),
    created_at: row.created_at,
    updated_at: row.updated_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
  });
}

export function buildExternalWorkerTaskSpec(input: ManagedWorkerTaskInput): ExternalWorkerTaskSpec {
  const metadata = input.metadata ?? {};
  return ExternalWorkerTaskSpecSchema.parse({
    job_id: input.job_id,
    task_id: input.task.task_id,
    objective: input.task.objective,
    done_criteria: input.task.done_criteria,
    allowed_tools: input.task.constraints.allowed_tools,
    forbidden_paths: input.task.constraints.forbidden_paths,
    timeout_ms: input.timeout_ms > 0 ? input.timeout_ms : null,
    working_directory: input.worker.cwd ?? asNullableString(metadata.working_directory),
    issue_id: asNullableString(metadata.issue_id),
    allowed_scope: asStringArray(metadata.allowed_scope),
    non_goals: asStringArray(metadata.non_goals),
    acceptance_criteria: asStringArray(metadata.acceptance_criteria),
    required_tests: asStringArray(metadata.required_tests),
    metadata,
  });
}

export function buildExternalWorkerArtifactRefs(input: ManagedWorkerTaskInput): ExternalWorkerArtifactRefs {
  const metadata = input.metadata ?? {};
  return ExternalWorkerArtifactRefsSchema.parse({
    working_directory: input.worker.cwd ?? asNullableString(metadata.working_directory),
    task_spec_path: asNullableString(metadata.task_spec_path),
    result_path: asNullableString(metadata.result_path),
    stdout_path: asNullableString(metadata.stdout_path),
    stderr_path: asNullableString(metadata.stderr_path),
  });
}

export function createExternalWorkerJob(input: ManagedWorkerTaskInput): ExternalWorkerJob {
  const timestamp = nowIso();
  return ExternalWorkerJobSchema.parse({
    id: input.job_id,
    tenant_id: input.tenant_id,
    agent_id: input.agent_id,
    task_id: input.task.task_id,
    adapter_id: input.worker.adapter,
    transport: input.worker.transport,
    status: 'queued',
    task_spec: buildExternalWorkerTaskSpec(input),
    artifact_refs: buildExternalWorkerArtifactRefs(input),
    metadata: input.metadata ?? {},
    created_at: timestamp,
    updated_at: timestamp,
  });
}

export function deriveFailureCategory(options: {
  status: ExternalWorkerJobStatus;
  launchFailed?: boolean;
  stalled?: boolean;
  resultMissing?: boolean;
  verifyFailed?: boolean;
}): ExternalWorkerFailureCategory | null {
  if (options.verifyFailed) return 'verify_failed';
  if (options.resultMissing) return 'result_missing';
  if (options.launchFailed) return 'launch_failed';
  if (options.stalled) return 'stalled';
  if (options.status === 'timed_out') return 'timed_out';
  if (options.status === 'failed') return 'runtime_error';
  return null;
}

export function buildExternalWorkerResultEnvelope(input: {
  job: ExternalWorkerJob;
  result: ResultEnvelope;
  artifacts?: string[];
  runtime_label?: string | null;
  stdout?: string | undefined;
  stderr?: string | undefined;
  failure_category?: ExternalWorkerFailureCategory | null;
}): ExternalWorkerResultEnvelope {
  const resultStatus: ExternalWorkerResultStatus =
    input.result.status === 'success'
      ? 'completed'
      : input.result.status === 'cancelled'
        ? 'cancelled'
        : input.result.status === 'partial'
          ? 'partial'
          : 'failed';

  return ExternalWorkerResultEnvelopeSchema.parse({
    job_id: input.job.id,
    task_id: input.job.task_id,
    adapter_id: input.job.adapter_id,
    status: resultStatus,
    summary: input.result.summary,
    output: input.result.output,
    tests_run: [],
    test_status: 'not_run',
    artifacts: input.artifacts ?? [],
    blocker: resultStatus === 'failed' || resultStatus === 'cancelled' ? input.result.summary : null,
    failure_category: input.failure_category ?? null,
    runtime_label: input.runtime_label ?? null,
    stdout_excerpt: input.stdout ? input.stdout.slice(0, 4000) : null,
    stderr_excerpt: input.stderr ? input.stderr.slice(0, 4000) : null,
    created_at: nowIso(),
  });
}

export function createPendingVerifyReport(job: ExternalWorkerJob): ExternalWorkerVerifyReport {
  return ExternalWorkerVerifyReportSchema.parse({
    job_id: job.id,
    status: 'pending',
    summary: 'Awaiting verifier review.',
    acceptance_criteria_missing: job.task_spec.acceptance_criteria,
    tests_checked: job.task_spec.required_tests,
    artifact_check: 'pending',
    created_at: nowIso(),
  });
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+|[\u4e00-\u9fff\u3400-\u4dbf]/g) ?? [];
}

function criterionSatisfied(criterion: string, evidence: string): boolean {
  const normalizedCriterion = criterion.trim().toLowerCase();
  const normalizedEvidence = evidence.trim().toLowerCase();
  if (!normalizedCriterion || !normalizedEvidence) return false;
  if (normalizedEvidence.includes(normalizedCriterion)) return true;

  const criterionTokens = tokenize(normalizedCriterion).filter((token) => token.length >= 2);
  if (criterionTokens.length === 0) return false;
  const evidenceTokens = new Set(tokenize(normalizedEvidence));
  const matched = criterionTokens.filter((token) => evidenceTokens.has(token)).length;
  return matched / criterionTokens.length >= 0.4;
}

export function createSynchronousVerifyReport(job: ExternalWorkerJob): ExternalWorkerVerifyReport {
  const result = job.result_envelope;
  if (!result || result.status !== 'completed') {
    return ExternalWorkerVerifyReportSchema.parse({
      job_id: job.id,
      status: 'failed',
      summary: 'Verification failed because the managed worker did not produce a completed result envelope.',
      acceptance_criteria_met: [],
      acceptance_criteria_missing: [],
      tests_checked: job.task_spec.required_tests,
      test_status: result?.test_status ?? 'not_run',
      artifact_check: 'failed',
      notes: ['Managed worker result envelope is missing or not completed.'],
      created_at: nowIso(),
    });
  }

  const acceptanceCriteria = job.task_spec.acceptance_criteria;
  const requiredTests = job.task_spec.required_tests;
  const evidence = [result.summary, ...result.output].filter((entry) => entry.trim().length > 0).join('\n');

  const acceptanceCriteriaMet = acceptanceCriteria.filter((criterion) => criterionSatisfied(criterion, evidence));
  const acceptanceCriteriaMissing = acceptanceCriteria.filter((criterion) => !acceptanceCriteriaMet.includes(criterion));

  const executedTests = result.tests_run;
  const allTestsObserved = requiredTests.every((required) => executedTests.some((executed) => executed.includes(required)));
  const testStatus = requiredTests.length === 0
    ? 'not_run'
    : allTestsObserved
      ? 'passed'
      : 'failed';

  const artifactCheck = result.artifacts.length > 0 || result.changed_files.length > 0 || evidence.length > 0
    ? 'passed'
    : 'failed';

  if (requiredTests.length === 0 && acceptanceCriteria.length === 0) {
    return ExternalWorkerVerifyReportSchema.parse({
      job_id: job.id,
      status: 'passed',
      summary: 'Verification passed. Managed worker completed and no explicit verifier requirements were configured.',
      acceptance_criteria_met: [],
      acceptance_criteria_missing: [],
      tests_checked: [],
      test_status: 'not_run',
      artifact_check: artifactCheck,
      diff_summary: result.changed_files.length > 0 ? `Changed files: ${result.changed_files.join(', ')}` : '',
      notes: ['Accepted the managed worker result because runtime reported success and no explicit required tests or acceptance criteria were configured.'],
      created_at: nowIso(),
    });
  }

  const notes: string[] = [];
  if (requiredTests.length > 0 && !allTestsObserved) {
    notes.push('Required tests were configured but the managed worker result did not report them as executed.');
  }
  if (acceptanceCriteriaMissing.length > 0) {
    notes.push('Some acceptance criteria were not evidenced by the managed worker summary/output.');
  }

  const passed = acceptanceCriteriaMissing.length === 0 && (requiredTests.length === 0 || allTestsObserved) && artifactCheck === 'passed';
  return ExternalWorkerVerifyReportSchema.parse({
    job_id: job.id,
    status: passed ? 'passed' : 'failed',
    summary: passed
      ? 'Verification passed.'
      : 'Verification failed. Managed worker output did not satisfy the configured acceptance requirements.',
    acceptance_criteria_met: acceptanceCriteriaMet,
    acceptance_criteria_missing: acceptanceCriteriaMissing,
    tests_checked: requiredTests,
    test_status: testStatus,
    artifact_check: artifactCheck,
    diff_summary: result.changed_files.length > 0 ? `Changed files: ${result.changed_files.join(', ')}` : '',
    notes,
    created_at: nowIso(),
  });
}

export function transitionExternalWorkerJob(
  job: ExternalWorkerJob,
  nextStatus: ExternalWorkerJobStatus,
  updates: Partial<Pick<
    ExternalWorkerJob,
    'failure_category' | 'runtime_label' | 'active_run_id' | 'last_error' | 'result_envelope' | 'verify_report'
  >> & {
    artifact_refs?: Partial<ExternalWorkerArtifactRefs>;
    metadata?: Record<string, unknown>;
  } = {},
): ExternalWorkerJob {
  if (job.status !== nextStatus && !STATUS_TRANSITIONS[job.status].includes(nextStatus)) {
    throw new Error(`Invalid external worker job transition: ${job.status} -> ${nextStatus}`);
  }

  const timestamp = nowIso();
  const artifactRefs = updates.artifact_refs
    ? ExternalWorkerArtifactRefsSchema.parse({
      ...job.artifact_refs,
      ...updates.artifact_refs,
    })
    : job.artifact_refs;

  return ExternalWorkerJobSchema.parse({
    ...job,
    status: nextStatus,
    failure_category:
      updates.failure_category !== undefined
        ? updates.failure_category
        : nextStatus === 'failed' || nextStatus === 'timed_out'
          ? deriveFailureCategory({ status: nextStatus })
          : null,
    runtime_label: updates.runtime_label !== undefined ? updates.runtime_label : job.runtime_label,
    active_run_id: updates.active_run_id !== undefined ? updates.active_run_id : job.active_run_id,
    last_error:
      updates.last_error !== undefined
        ? updates.last_error
        : nextStatus === 'completed_pending_verify' || nextStatus === 'succeeded'
          ? null
          : job.last_error,
    artifact_refs: artifactRefs,
    result_envelope:
      updates.result_envelope !== undefined ? updates.result_envelope : job.result_envelope,
    verify_report:
      updates.verify_report !== undefined ? updates.verify_report : job.verify_report,
    metadata:
      updates.metadata !== undefined
        ? {
          ...job.metadata,
          ...updates.metadata,
        }
        : job.metadata,
    updated_at: timestamp,
    started_at:
      (nextStatus === 'launching' || nextStatus === 'running') && !job.started_at
        ? timestamp
        : job.started_at,
    completed_at:
      isTerminalJobStatus(nextStatus)
        ? job.completed_at ?? timestamp
        : job.completed_at,
  });
}

export function persistExternalWorkerJob(job: ExternalWorkerJob): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO external_worker_jobs (
      id,
      tenant_id,
      agent_id,
      task_id,
      adapter_id,
      transport,
      status,
      failure_category,
      runtime_label,
      active_run_id,
      last_error,
      task_spec,
      artifact_refs,
      result_envelope,
      verify_report,
      metadata,
      created_at,
      updated_at,
      started_at,
      completed_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      tenant_id = excluded.tenant_id,
      agent_id = excluded.agent_id,
      task_id = excluded.task_id,
      adapter_id = excluded.adapter_id,
      transport = excluded.transport,
      status = excluded.status,
      failure_category = excluded.failure_category,
      runtime_label = excluded.runtime_label,
      active_run_id = excluded.active_run_id,
      last_error = excluded.last_error,
      task_spec = excluded.task_spec,
      artifact_refs = excluded.artifact_refs,
      result_envelope = excluded.result_envelope,
      verify_report = excluded.verify_report,
      metadata = excluded.metadata,
      updated_at = excluded.updated_at,
      started_at = excluded.started_at,
      completed_at = excluded.completed_at
  `).run(
    job.id,
    job.tenant_id,
    job.agent_id,
    job.task_id,
    job.adapter_id,
    job.transport,
    job.status,
    job.failure_category,
    job.runtime_label,
    job.active_run_id,
    job.last_error,
    JSON.stringify(job.task_spec),
    JSON.stringify(job.artifact_refs),
    job.result_envelope ? JSON.stringify(job.result_envelope) : null,
    job.verify_report ? JSON.stringify(job.verify_report) : null,
    JSON.stringify(job.metadata),
    job.created_at,
    job.updated_at,
    job.started_at,
    job.completed_at,
  );
}

export function getExternalWorkerJob(id: string, tenantId = 'default'): ExternalWorkerJob | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT *
    FROM external_worker_jobs
    WHERE id = ? AND tenant_id = ?
    LIMIT 1
  `).get(id, tenantId) as ExternalWorkerJobRow | undefined;

  if (!row) return null;
  return parseRow(row);
}

export function listExternalWorkerJobsForChat(
  chatId: string,
  tenantId = 'default',
  statuses?: ExternalWorkerJobStatus[],
  limit = 20,
): ExternalWorkerJob[] {
  const db = getDb();
  const cappedLimit =
    Number.isFinite(limit) && limit > 0
      ? Math.floor(limit)
      : 20;
  const clauses = ['tenant_id = ?', "json_extract(metadata, '$.chat_id') = ?"];
  const params: unknown[] = [tenantId, chatId];

  if (statuses && statuses.length > 0) {
    clauses.push(`status IN (${statuses.map(() => '?').join(', ')})`);
    params.push(...statuses);
  }

  const rows = db.prepare(`
    SELECT *
    FROM external_worker_jobs
    WHERE ${clauses.join(' AND ')}
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(...params, cappedLimit) as ExternalWorkerJobRow[];

  return rows.map(parseRow);
}

export function getLatestExternalWorkerJobForChat(chatId: string, tenantId = 'default'): ExternalWorkerJob | null {
  return listExternalWorkerJobsForChat(chatId, tenantId, undefined, 1)[0] ?? null;
}

export function listExternalWorkerJobsForTask(
  taskId: string,
  tenantId = 'default',
  statuses?: ExternalWorkerJobStatus[],
  limit = 20,
): ExternalWorkerJob[] {
  const db = getDb();
  const cappedLimit =
    Number.isFinite(limit) && limit > 0
      ? Math.floor(limit)
      : 20;
  const clauses = ['tenant_id = ?', 'task_id = ?'];
  const params: unknown[] = [tenantId, taskId];

  if (statuses && statuses.length > 0) {
    clauses.push(`status IN (${statuses.map(() => '?').join(', ')})`);
    params.push(...statuses);
  }

  const rows = db.prepare(`
    SELECT *
    FROM external_worker_jobs
    WHERE ${clauses.join(' AND ')}
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(...params, cappedLimit) as ExternalWorkerJobRow[];

  return rows.map(parseRow);
}

export function getLatestExternalWorkerJobForTask(taskId: string, tenantId = 'default'): ExternalWorkerJob | null {
  return listExternalWorkerJobsForTask(taskId, tenantId, undefined, 1)[0] ?? null;
}

export function listExternalWorkerJobs(filters: ExternalWorkerJobFilters = {}): ExternalWorkerJob[] {
  const db = getDb();
  const tenantId = filters.tenant_id ?? 'default';
  const limit =
    typeof filters.limit === 'number' && Number.isFinite(filters.limit) && filters.limit > 0
      ? Math.floor(filters.limit)
      : 100;
  const clauses = ['tenant_id = ?'];
  const params: unknown[] = [tenantId];

  if (filters.statuses && filters.statuses.length > 0) {
    clauses.push(`status IN (${filters.statuses.map(() => '?').join(', ')})`);
    params.push(...filters.statuses);
  }
  if (filters.adapter_id) {
    clauses.push('adapter_id = ?');
    params.push(filters.adapter_id);
  }

  const rows = db.prepare(`
    SELECT *
    FROM external_worker_jobs
    WHERE ${clauses.join(' AND ')}
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(...params, limit) as ExternalWorkerJobRow[];

  return rows.map(parseRow);
}

/**
 * Mark stale in-flight worker jobs (queued/launching/running) as failed on startup.
 * These are orphans from a previous process that will never complete.
 */
export function reapStaleWorkerJobs(maxAgeMs = 3_600_000): number {
  const db = getDb();
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const result = db.prepare(`
    UPDATE external_worker_jobs
    SET status = 'failed',
        failure_category = 'stalled',
        last_error = 'Reaped as stale on startup (process restarted while job was in-flight)',
        updated_at = ?,
        completed_at = ?
    WHERE status IN ('queued', 'launching', 'running')
      AND updated_at < ?
  `).run(new Date().toISOString(), new Date().toISOString(), cutoff);
  return result.changes;
}
