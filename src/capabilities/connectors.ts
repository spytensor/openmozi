import pino from 'pino';
import { getDb } from '../store/db.js';
import { log as logEvent } from '../store/events.js';
import { createApprovalRequest, formatApprovalNotification, getRequest } from '../security/gates.js';
import { getConfig } from '../config/index.js';

const logger = pino({ name: 'mozi:capability:connectors' });

export type ConnectorName = 'gmail' | 'calendar' | 'slack' | 'github';

export interface ConnectorAuthInput {
  token?: string;
  base_url?: string;
}

export interface ConnectorExecuteOptions {
  connector: ConnectorName;
  action: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  maxRetries?: number;
  retryBackoffMs?: number;
  approvalRequestId?: string;
  tenantId?: string;
  auth?: ConnectorAuthInput;
}

export interface ConnectorExecuteResult {
  connector: ConnectorName;
  action: string;
  idempotencyKey: string;
  attempts: number;
  cached: boolean;
  externalId?: string;
  data: Record<string, unknown>;
}

interface ConnectorInvocationRow {
  tenant_id: string;
  connector: string;
  action: string;
  idempotency_key: string;
  status: 'in_progress' | 'succeeded' | 'failed';
  attempts: number;
  request_fingerprint: string;
  response_json: string | null;
  last_error: string | null;
}

interface ConnectorAuthResolved {
  token: string;
  baseUrl: string;
}

interface ConnectorExecutionPayload {
  action: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}

interface ConnectorExecutionOutput {
  externalId?: string;
  data: Record<string, unknown>;
}

interface ConnectorAdapter {
  auth(input?: ConnectorAuthInput): ConnectorAuthResolved;
  execute(payload: ConnectorExecutionPayload, auth: ConnectorAuthResolved): Promise<ConnectorExecutionOutput>;
}

class ConnectorHttpError extends Error {
  retryable: boolean;
  status?: number;

  constructor(message: string, retryable: boolean, status?: number) {
    super(message);
    this.retryable = retryable;
    this.status = status;
  }
}

let tableEnsured = false;

function ensureTable(): void {
  if (tableEnsured) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS connector_invocations (
      tenant_id TEXT NOT NULL DEFAULT 'default',
      connector TEXT NOT NULL,
      action TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'in_progress' CHECK(status IN ('in_progress', 'succeeded', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      request_fingerprint TEXT NOT NULL,
      response_json TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (tenant_id, connector, action, idempotency_key)
    );
  `);
  tableEnsured = true;
}

export function resetConnectorTableFlag(): void {
  tableEnsured = false;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const objectValue = value as Record<string, unknown>;
  const keys = Object.keys(objectValue).sort((a, b) => a.localeCompare(b));
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(objectValue[k])}`).join(',')}}`;
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function requireString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`payload.${key} must be a non-empty string`);
  }
  return value.trim();
}

function requireNumber(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`payload.${key} must be a number`);
  }
  return value;
}

function requireRecord(payload: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = payload[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`payload.${key} must be an object`);
  }
  return value as Record<string, unknown>;
}

function isRetryableError(err: unknown): boolean {
  return err instanceof ConnectorHttpError ? err.retryable : false;
}

function clampRetries(value: number | undefined): number {
  if (value === undefined) return 2;
  if (!Number.isInteger(value) || value < 0 || value > 5) {
    throw new Error('maxRetries must be an integer between 0 and 5');
  }
  return value;
}

function clampBackoffMs(value: number | undefined): number {
  if (value === undefined) return 1000;
  if (!Number.isFinite(value) || value < 0 || value > 30_000) {
    throw new Error('retryBackoffMs must be between 0 and 30000');
  }
  return Math.floor(value);
}

function isSendAction(action: string): boolean {
  return /(send|post|create|comment|reply|invite|update|delete|publish|dispatch|assign)/i.test(action);
}

function enforceApprovalIfNeeded(params: {
  connector: ConnectorName;
  action: string;
  tenantId: string;
  payload: Record<string, unknown>;
  approvalRequestId?: string;
}): void {
  if (!isSendAction(params.action)) return;

  // Respect config: skip approval if external_comm is not in hard_gates
  const hardGates = getConfig().security.hard_gates ?? [];
  if (!hardGates.includes('external_comm')) return;

  const requestId = params.approvalRequestId?.trim();
  if (requestId) {
    const req = getRequest(requestId, params.tenantId);
    if (!req) throw new Error(`Approval request not found: ${requestId}`);
    if (req.status !== 'approved') {
      throw new Error(`Approval request ${requestId} is ${req.status}. Use /approve ${requestId} first.`);
    }
    return;
  }

  const req = createApprovalRequest(
    'external_comm',
    `Connector action requires approval: ${params.connector}.${params.action}`,
    {
      connector: params.connector,
      action: params.action,
      idempotency_preview: stableStringify({
        payload_keys: Object.keys(params.payload).slice(0, 12),
      }),
    },
    'connector_tool',
    params.tenantId,
  );
  throw new Error(formatApprovalNotification(req));
}

async function requestJson(
  url: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ConnectorHttpError(`Network error: ${message}`, true);
  }

  const raw = await response.text();
  let parsed: unknown = {};
  if (raw.trim()) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { raw };
    }
  }

  if (!response.ok) {
    const retryable = response.status >= 500 || response.status === 429 || response.status === 408;
    const detail = typeof (parsed as Record<string, unknown>)?.error === 'string'
      ? (parsed as Record<string, unknown>).error as string
      : raw.slice(0, 200);
    throw new ConnectorHttpError(`HTTP ${response.status}: ${detail}`, retryable, response.status);
  }

  return asRecord(parsed);
}

function resolveToken(
  inputToken: string | undefined,
  envVars: string[],
  connector: ConnectorName,
): string {
  const explicit = inputToken?.trim();
  if (explicit) return explicit;
  for (const envKey of envVars) {
    const fromEnv = process.env[envKey]?.trim();
    if (fromEnv) return fromEnv;
  }
  throw new Error(`Missing auth token for ${connector}. Provide auth.token or set ${envVars.join(' / ')}`);
}

const adapters: Record<ConnectorName, ConnectorAdapter> = {
  slack: {
    auth(input) {
      return {
        token: resolveToken(input?.token, ['SLACK_BOT_TOKEN'], 'slack'),
        baseUrl: normalizeBaseUrl(input?.base_url?.trim() || process.env.SLACK_API_BASE_URL || 'https://slack.com'),
      };
    },
    async execute(payload, auth) {
      if (payload.action !== 'post_message') {
        throw new Error(`Unsupported slack action: ${payload.action}`);
      }
      const channel = requireString(payload.payload, 'channel');
      const text = requireString(payload.payload, 'text');
      const body: Record<string, unknown> = { channel, text };
      if (typeof payload.payload.thread_ts === 'string') body.thread_ts = payload.payload.thread_ts;
      const data = await requestJson(
        `${auth.baseUrl}/api/chat.postMessage`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${auth.token}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': payload.idempotencyKey,
            'X-Idempotency-Key': payload.idempotencyKey,
          },
          body: JSON.stringify(body),
        },
      );
      if (data.ok === false) {
        const reason = typeof data.error === 'string' ? data.error : 'unknown';
        throw new ConnectorHttpError(`Slack API error: ${reason}`, false);
      }
      return {
        externalId: typeof data.ts === 'string' ? data.ts : undefined,
        data,
      };
    },
  },

  github: {
    auth(input) {
      return {
        token: resolveToken(input?.token, ['GITHUB_TOKEN'], 'github'),
        baseUrl: normalizeBaseUrl(input?.base_url?.trim() || process.env.GITHUB_API_BASE_URL || 'https://api.github.com'),
      };
    },
    async execute(payload, auth) {
      const owner = requireString(payload.payload, 'owner');
      const repo = requireString(payload.payload, 'repo');
      const marker = `<!-- mozi:idempotency:${payload.idempotencyKey} -->`;

      if (payload.action === 'create_issue') {
        const title = requireString(payload.payload, 'title');
        const rawBody = typeof payload.payload.body === 'string' ? payload.payload.body : '';
        const body = rawBody.includes(marker) ? rawBody : [rawBody, marker].filter(Boolean).join('\n\n');
        const data = await requestJson(
          `${auth.baseUrl}/repos/${owner}/${repo}/issues`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${auth.token}`,
              Accept: 'application/vnd.github+json',
              'Content-Type': 'application/json',
              'X-GitHub-Api-Version': '2022-11-28',
              'Idempotency-Key': payload.idempotencyKey,
            },
            body: JSON.stringify({ title, body }),
          },
        );
        return {
          externalId: typeof data.number === 'number' ? String(data.number) : undefined,
          data,
        };
      }

      if (payload.action === 'comment_issue') {
        const issueNumber = requireNumber(payload.payload, 'issue_number');
        const rawBody = requireString(payload.payload, 'body');
        const body = rawBody.includes(marker) ? rawBody : `${rawBody}\n\n${marker}`;
        const data = await requestJson(
          `${auth.baseUrl}/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${auth.token}`,
              Accept: 'application/vnd.github+json',
              'Content-Type': 'application/json',
              'X-GitHub-Api-Version': '2022-11-28',
              'Idempotency-Key': payload.idempotencyKey,
            },
            body: JSON.stringify({ body }),
          },
        );
        return {
          externalId: typeof data.id === 'number' ? String(data.id) : undefined,
          data,
        };
      }

      throw new Error(`Unsupported github action: ${payload.action}`);
    },
  },

  gmail: {
    auth(input) {
      return {
        token: resolveToken(input?.token, ['GMAIL_ACCESS_TOKEN', 'GOOGLE_ACCESS_TOKEN'], 'gmail'),
        baseUrl: normalizeBaseUrl(input?.base_url?.trim() || process.env.GMAIL_API_BASE_URL || 'https://gmail.googleapis.com'),
      };
    },
    async execute(payload, auth) {
      if (payload.action !== 'send_email' && payload.action !== 'draft_email') {
        throw new Error(`Unsupported gmail action: ${payload.action}`);
      }
      const to = requireString(payload.payload, 'to');
      const subject = requireString(payload.payload, 'subject');
      const body = requireString(payload.payload, 'body');
      const lines = [
        `To: ${to}`,
        `Subject: ${subject}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset="UTF-8"',
        `X-Mozi-Idempotency-Key: ${payload.idempotencyKey}`,
        '',
        body,
      ];
      const raw = Buffer.from(lines.join('\n')).toString('base64url');
      const endpoint = payload.action === 'send_email'
        ? `${auth.baseUrl}/gmail/v1/users/me/messages/send`
        : `${auth.baseUrl}/gmail/v1/users/me/drafts`;
      const bodyData = payload.action === 'send_email'
        ? { raw }
        : { message: { raw } };
      const data = await requestJson(
        endpoint,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${auth.token}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': payload.idempotencyKey,
          },
          body: JSON.stringify(bodyData),
        },
      );
      const messageRecord = asRecord(data.message);
      return {
        externalId: typeof data.id === 'string'
          ? data.id
          : (typeof messageRecord.id === 'string' ? messageRecord.id : undefined),
        data,
      };
    },
  },

  calendar: {
    auth(input) {
      return {
        token: resolveToken(input?.token, ['GOOGLE_CALENDAR_ACCESS_TOKEN', 'GOOGLE_ACCESS_TOKEN'], 'calendar'),
        baseUrl: normalizeBaseUrl(input?.base_url?.trim() || process.env.GOOGLE_CALENDAR_API_BASE_URL || 'https://www.googleapis.com'),
      };
    },
    async execute(payload, auth) {
      if (payload.action !== 'create_event') {
        throw new Error(`Unsupported calendar action: ${payload.action}`);
      }
      const summary = requireString(payload.payload, 'summary');
      const start = requireRecord(payload.payload, 'start');
      const end = requireRecord(payload.payload, 'end');
      const calendarId = typeof payload.payload.calendar_id === 'string' && payload.payload.calendar_id.trim()
        ? payload.payload.calendar_id.trim()
        : 'primary';

      const eventBody: Record<string, unknown> = {
        ...payload.payload,
        summary,
        start,
        end,
      };
      delete eventBody.calendar_id;

      const baseExtended = asRecord(eventBody.extendedProperties);
      const basePrivate = asRecord(baseExtended.private);
      eventBody.extendedProperties = {
        ...baseExtended,
        private: {
          ...basePrivate,
          mozi_idempotency_key: payload.idempotencyKey,
        },
      };

      const encodedCalendarId = encodeURIComponent(calendarId);
      const data = await requestJson(
        `${auth.baseUrl}/calendar/v3/calendars/${encodedCalendarId}/events`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${auth.token}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': payload.idempotencyKey,
          },
          body: JSON.stringify(eventBody),
        },
      );
      return {
        externalId: typeof data.id === 'string' ? data.id : undefined,
        data,
      };
    },
  },
};

function getInvocation(
  tenantId: string,
  connector: ConnectorName,
  action: string,
  idempotencyKey: string,
): ConnectorInvocationRow | undefined {
  const db = getDb();
  const row = db.prepare(`
    SELECT tenant_id, connector, action, idempotency_key, status, attempts, request_fingerprint, response_json, last_error
    FROM connector_invocations
    WHERE tenant_id = ? AND connector = ? AND action = ? AND idempotency_key = ?
  `).get(tenantId, connector, action, idempotencyKey) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    tenant_id: row.tenant_id as string,
    connector: row.connector as string,
    action: row.action as string,
    idempotency_key: row.idempotency_key as string,
    status: row.status as 'in_progress' | 'succeeded' | 'failed',
    attempts: Number(row.attempts ?? 0),
    request_fingerprint: row.request_fingerprint as string,
    response_json: (row.response_json as string | null) ?? null,
    last_error: (row.last_error as string | null) ?? null,
  };
}

function initializeInvocation(
  tenantId: string,
  connector: ConnectorName,
  action: string,
  idempotencyKey: string,
  fingerprint: string,
): { row: ConnectorInvocationRow; inserted: boolean } {
  const db = getDb();
  const result = db.prepare(`
    INSERT OR IGNORE INTO connector_invocations
      (tenant_id, connector, action, idempotency_key, status, attempts, request_fingerprint, response_json, last_error, updated_at)
    VALUES (?, ?, ?, ?, 'in_progress', 0, ?, NULL, NULL, datetime('now'))
  `).run(tenantId, connector, action, idempotencyKey, fingerprint);

  const row = getInvocation(tenantId, connector, action, idempotencyKey);
  if (!row) {
    throw new Error('Failed to initialize connector invocation record');
  }
  if (row.request_fingerprint !== fingerprint) {
    throw new Error(`idempotency_key reuse conflict for ${connector}.${action}`);
  }
  return {
    row,
    inserted: Number(result.changes ?? 0) > 0,
  };
}

function markAttempt(
  tenantId: string,
  connector: ConnectorName,
  action: string,
  idempotencyKey: string,
  attempt: number,
): void {
  const db = getDb();
  db.prepare(`
    UPDATE connector_invocations
    SET status = 'in_progress', attempts = ?, updated_at = datetime('now')
    WHERE tenant_id = ? AND connector = ? AND action = ? AND idempotency_key = ?
  `).run(attempt, tenantId, connector, action, idempotencyKey);
}

function markSuccess(
  tenantId: string,
  connector: ConnectorName,
  action: string,
  idempotencyKey: string,
  attempt: number,
  result: ConnectorExecutionOutput,
): void {
  const db = getDb();
  db.prepare(`
    UPDATE connector_invocations
    SET status = 'succeeded', attempts = ?, response_json = ?, last_error = NULL, updated_at = datetime('now')
    WHERE tenant_id = ? AND connector = ? AND action = ? AND idempotency_key = ?
  `).run(
    attempt,
    JSON.stringify(result),
    tenantId,
    connector,
    action,
    idempotencyKey,
  );
}

function markFailed(
  tenantId: string,
  connector: ConnectorName,
  action: string,
  idempotencyKey: string,
  attempt: number,
  message: string,
): void {
  const db = getDb();
  db.prepare(`
    UPDATE connector_invocations
    SET status = 'failed', attempts = ?, last_error = ?, updated_at = datetime('now')
    WHERE tenant_id = ? AND connector = ? AND action = ? AND idempotency_key = ?
  `).run(attempt, message.slice(0, 2000), tenantId, connector, action, idempotencyKey);
}

function deleteInvocation(
  tenantId: string,
  connector: ConnectorName,
  action: string,
  idempotencyKey: string,
): void {
  const db = getDb();
  db.prepare(`
    DELETE FROM connector_invocations
    WHERE tenant_id = ? AND connector = ? AND action = ? AND idempotency_key = ?
  `).run(tenantId, connector, action, idempotencyKey);
}

function parseStoredResult(responseJson: string | null): ConnectorExecutionOutput {
  if (!responseJson) {
    return { data: {} };
  }
  try {
    const parsed = JSON.parse(responseJson) as Record<string, unknown>;
    const externalId = typeof parsed.externalId === 'string' ? parsed.externalId : undefined;
    const data = asRecord(parsed.data);
    return { externalId, data };
  } catch {
    return { data: {} };
  }
}

async function waitMs(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function executeConnector(options: ConnectorExecuteOptions): Promise<ConnectorExecuteResult> {
  ensureTable();

  const connector = options.connector;
  const adapter = adapters[connector];
  if (!adapter) {
    throw new Error(`Unsupported connector: ${connector}`);
  }

  const action = options.action.trim().toLowerCase();
  if (!action) throw new Error('action is required');

  const idempotencyKey = options.idempotencyKey.trim();
  if (!idempotencyKey) throw new Error('idempotencyKey is required');
  if (idempotencyKey.length > 128) {
    throw new Error('idempotencyKey must be <= 128 characters');
  }

  const payload = asRecord(options.payload);
  const tenantId = options.tenantId ?? 'default';
  const maxRetries = clampRetries(options.maxRetries);
  const retryBackoffMs = clampBackoffMs(options.retryBackoffMs);

  const operationId = `${connector}:${action}:${idempotencyKey}`;
  const fingerprint = stableStringify({ connector, action, payload });
  const invocation = initializeInvocation(tenantId, connector, action, idempotencyKey, fingerprint);
  if (invocation.row.status === 'succeeded') {
    const cached = parseStoredResult(invocation.row.response_json);
    return {
      connector,
      action,
      idempotencyKey,
      attempts: invocation.row.attempts,
      cached: true,
      externalId: cached.externalId,
      data: cached.data,
    };
  }
  if (invocation.row.status === 'in_progress' && !invocation.inserted) {
    throw new Error(`Connector invocation already in progress: ${operationId}`);
  }

  try {
    enforceApprovalIfNeeded({
      connector,
      action,
      payload,
      tenantId,
      approvalRequestId: options.approvalRequestId,
    });
  } catch (err) {
    if (invocation.inserted) {
      deleteInvocation(tenantId, connector, action, idempotencyKey);
    }
    throw err;
  }

  let auth: ConnectorAuthResolved;
  try {
    auth = adapter.auth(options.auth);
  } catch (err) {
    if (invocation.inserted) {
      deleteInvocation(tenantId, connector, action, idempotencyKey);
    }
    throw err;
  }
  logEvent('connector_invoked', 'connector', operationId, {
    connector,
    action,
    idempotency_key: idempotencyKey,
    max_retries: maxRetries,
  }, tenantId);

  let attempts = invocation.row.attempts;

  for (let retry = 0; retry <= maxRetries; retry += 1) {
    attempts += 1;
    markAttempt(tenantId, connector, action, idempotencyKey, attempts);
    try {
      const result = await adapter.execute({ action, payload, idempotencyKey }, auth);
      markSuccess(tenantId, connector, action, idempotencyKey, attempts, result);
      logEvent('connector_succeeded', 'connector', operationId, {
        connector,
        action,
        idempotency_key: idempotencyKey,
        attempt: attempts,
        external_id: result.externalId ?? null,
      }, tenantId);
      return {
        connector,
        action,
        idempotencyKey,
        attempts,
        cached: false,
        externalId: result.externalId,
        data: result.data,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      markFailed(tenantId, connector, action, idempotencyKey, attempts, message);
      const retryable = isRetryableError(err);
      const canRetry = retryable && retry < maxRetries;
      logEvent('connector_failed', 'connector', operationId, {
        connector,
        action,
        idempotency_key: idempotencyKey,
        attempt: attempts,
        retryable,
        will_retry: canRetry,
        error: message.slice(0, 500),
      }, tenantId);
      if (!canRetry) {
        throw new Error(`Connector ${connector}.${action} failed after ${attempts} attempt(s): ${message}`);
      }
      const waitTime = Math.min(retryBackoffMs * (retry + 1), 30_000);
      logger.warn({
        connector,
        action,
        idempotencyKey,
        attempt: attempts,
        wait_ms: waitTime,
        error: message,
      }, 'Connector call failed, retrying');
      await waitMs(waitTime);
    }
  }

  throw new Error(`Connector ${connector}.${action} failed: retry budget exhausted`);
}
