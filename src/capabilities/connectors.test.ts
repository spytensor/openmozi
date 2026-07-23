import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';

const hoisted = vi.hoisted(() => ({
  createApprovalRequestMock: vi.fn(() => ({
    id: 'approval-1',
    action: 'external_comm',
    description: 'connector action',
    status: 'pending',
  })),
  formatApprovalNotificationMock: vi.fn(() => '[APPROVAL NEEDED] ID: approval-1 Use /approve approval-1'),
  getRequestMock: vi.fn(() => ({
    id: 'approval-1',
    status: 'approved',
  })),
  mockHardGates: [] as string[],
}));

vi.mock('../security/gates.js', () => ({
  createApprovalRequest: hoisted.createApprovalRequestMock,
  formatApprovalNotification: hoisted.formatApprovalNotificationMock,
  getRequest: hoisted.getRequestMock,
}));

vi.mock('../config/index.js', () => ({
  getConfig: () => ({
    security: { hard_gates: hoisted.mockHardGates },
  }),
}));

import { executeConnector, resetConnectorTableFlag } from './connectors.js';

let dbTmpDir = '';
const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeAll(() => {
  const db = setupTestDb();
  dbTmpDir = db.tmpDir;
  vi.stubGlobal('fetch', fetchMock);
});

afterAll(() => {
  vi.unstubAllGlobals();
  resetConnectorTableFlag();
  teardownTestDb(dbTmpDir);
});

beforeEach(() => {
  fetchMock.mockReset();
  hoisted.createApprovalRequestMock.mockClear();
  hoisted.formatApprovalNotificationMock.mockClear();
  hoisted.getRequestMock.mockClear();
  hoisted.mockHardGates = [];
  resetConnectorTableFlag();
});

describe('capabilities/connectors', () => {
  it('skips approval for send actions when hard_gates is empty (default)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, ts: '1700000000.000000' }));

    const result = await executeConnector({
      connector: 'slack',
      action: 'post_message',
      payload: { channel: 'C1', text: 'hello' },
      idempotencyKey: 'idem-no-approval',
      auth: { token: 'slack-token' },
      tenantId: 'default',
    });

    expect(result.cached).toBe(false);
    expect(hoisted.createApprovalRequestMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('requires approval for send actions when external_comm is in hard_gates', async () => {
    hoisted.mockHardGates = ['external_comm'];

    await expect(executeConnector({
      connector: 'slack',
      action: 'post_message',
      payload: { channel: 'C1', text: 'hello' },
      idempotencyKey: 'idem-approval',
      auth: { token: 'slack-token' },
      tenantId: 'default',
    })).rejects.toThrow('/approve');

    expect(hoisted.createApprovalRequestMock).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('executes connector call and returns cached result for same idempotency key', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, ts: '1700000000.100000' }));

    const first = await executeConnector({
      connector: 'slack',
      action: 'post_message',
      payload: { channel: 'C1', text: 'hello world' },
      idempotencyKey: 'idem-cache',
      auth: { token: 'slack-token' },
      tenantId: 'default',
    });
    const second = await executeConnector({
      connector: 'slack',
      action: 'post_message',
      payload: { channel: 'C1', text: 'hello world' },
      idempotencyKey: 'idem-cache',
      auth: { token: 'slack-token' },
      tenantId: 'default',
    });

    expect(first.cached).toBe(false);
    expect(first.attempts).toBe(1);
    expect(second.cached).toBe(true);
    expect(second.externalId).toBe('1700000000.100000');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries transient failures and succeeds without duplicating record state', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'upstream down' }, 500))
      .mockResolvedValueOnce(jsonResponse({ ok: true, ts: '1700000000.200000' }, 200));

    const result = await executeConnector({
      connector: 'slack',
      action: 'post_message',
      payload: { channel: 'C2', text: 'retry once' },
      idempotencyKey: 'idem-retry',
      auth: { token: 'slack-token' },
      tenantId: 'default',
      maxRetries: 2,
      retryBackoffMs: 0,
    });

    expect(result.cached).toBe(false);
    expect(result.attempts).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-retryable 4xx responses', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'bad request' }, 400));

    await expect(executeConnector({
      connector: 'slack',
      action: 'post_message',
      payload: { channel: 'C3', text: 'no retry' },
      idempotencyKey: 'idem-4xx',
      auth: { token: 'slack-token' },
      tenantId: 'default',
      maxRetries: 3,
      retryBackoffMs: 0,
    })).rejects.toThrow('failed after 1 attempt');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects idempotency key reuse with a different payload fingerprint', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, ts: '1700000000.300000' }));

    await executeConnector({
      connector: 'slack',
      action: 'post_message',
      payload: { channel: 'C4', text: 'original payload' },
      idempotencyKey: 'idem-conflict',
      auth: { token: 'slack-token' },
      tenantId: 'default',
    });

    await expect(executeConnector({
      connector: 'slack',
      action: 'post_message',
      payload: { channel: 'C4', text: 'different payload' },
      idempotencyKey: 'idem-conflict',
      auth: { token: 'slack-token' },
      tenantId: 'default',
    })).rejects.toThrow('idempotency_key reuse conflict');
  });
});
