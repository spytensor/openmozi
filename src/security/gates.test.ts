import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import {
  createSession,
  getSessionPermissionLevel,
  updateSessionPermissionLevel,
} from '../memory/sessions.js';
import { queryAuditLog } from './audit.js';
import {
  isHardGateAction,
  createApprovalRequest,
  approveRequest,
  rejectRequest,
  getRequest,
  getPendingRequests,
  listRequests,
  formatApprovalNotification,
  resetTableFlag,
  HARD_GATE_ACTIONS,
} from './gates.js';
import { on as onProgressEvent, type ProgressEvent } from '../progress/event-bus.js';

let tmpDir: string;

beforeAll(() => {
  const result = setupTestDb();
  tmpDir = result.tmpDir;
  resetTableFlag();
});

afterAll(() => {
  teardownTestDb(tmpDir);
});

describe('security/gates', () => {
  describe('isHardGateAction', () => {
    it('returns true for all hard gate actions', () => {
      for (const action of HARD_GATE_ACTIONS) {
        expect(isHardGateAction(action)).toBe(true);
      }
    });

    it('returns false for non-gate actions', () => {
      expect(isHardGateAction('read_file')).toBe(false);
      expect(isHardGateAction('')).toBe(false);
    });
  });

  describe('createApprovalRequest', () => {
    it('creates a pending approval request', () => {
      const req = createApprovalRequest(
        'skill_register',
        'Register new skill: code-format',
        { skill_id: 'code-format' },
        'agent-1',
      );

      expect(req.id).toBeTruthy();
      expect(req.action).toBe('skill_register');
      expect(req.description).toBe('Register new skill: code-format');
      expect(req.status).toBe('pending');
      expect(req.requested_by).toBe('agent-1');
      expect(req.context).toEqual({ skill_id: 'code-format' });
    });

    it('creates request without context', () => {
      const req = createApprovalRequest('l3_grant', 'Grant L3 access to agent-2');
      expect(req.context).toBeNull();
      expect(req.requested_by).toBe('system');
    });
  });

  describe('approveRequest', () => {
    it('approves a pending request', () => {
      const req = createApprovalRequest('agent_promote', 'Promote agent coder-v2');
      const approved = approveRequest(req.id, 'admin');

      expect(approved.status).toBe('approved');
      expect(approved.resolved_by).toBe('admin');
      expect(approved.resolved_at).toBeTruthy();
    });

    it('throws if request not found', () => {
      expect(() => approveRequest('nonexistent')).toThrow('not found');
    });

    it('throws if request already resolved', () => {
      const req = createApprovalRequest('l3_grant', 'test');
      approveRequest(req.id);
      expect(() => approveRequest(req.id)).toThrow('already');
    });

    it('raises session permission level and audits permission elevation approvals', () => {
      const tenantId = 'tenant-gates-elevation';
      const session = createSession('user-gates', 'Permission elevation', tenantId);
      updateSessionPermissionLevel(session.id, 'L1_READ_WRITE', tenantId);
      const req = createApprovalRequest(
        'permission_elevation',
        'Raise this session for network search',
        {
          sessionId: session.id,
          current_level: 'L1_READ_WRITE',
          required_level: 'L3_FULL_ACCESS',
          denied_action: 'network.request',
          tool: 'web_search',
        },
        'session:test',
        tenantId,
      );

      const approved = approveRequest(req.id, 'operator-1', tenantId);

      expect(approved.status).toBe('approved');
      expect(getSessionPermissionLevel(session.id, tenantId)).toBe('L3_FULL_ACCESS');
      const audit = queryAuditLog({ tenant_id: tenantId, action: 'session.permission' });
      expect(audit.entries[0]).toMatchObject({
        user_id: 'operator-1',
        resource_type: 'session',
        resource_id: session.id,
      });
      expect(audit.entries[0].details).toMatchObject({
        permission_level: 'L3_FULL_ACCESS',
        approval_request_id: req.id,
        reason: 'permission_full_access_approved',
      });
    });

    it('records a one-time permission elevation without changing session access', () => {
      const tenantId = 'tenant-gates-elevation-once';
      const session = createSession('user-gates-once', 'Permission elevation once', tenantId);
      updateSessionPermissionLevel(session.id, 'L1_READ_WRITE', tenantId);
      const req = createApprovalRequest('permission_elevation', 'Allow this search once', {
        sessionId: session.id,
        current_level: 'L1_READ_WRITE',
        required_level: 'L2_SHELL_EXEC',
      }, 'session:test', tenantId);

      const approved = approveRequest(req.id, 'operator-1', tenantId, { grantScope: 'once' });

      expect(approved.context).toMatchObject({ grant_scope: 'once' });
      expect(getSessionPermissionLevel(session.id, tenantId)).toBe('L1_READ_WRITE');
    });

    it('emits approval_resolved when a request is approved', () => {
      const events: ProgressEvent[] = [];
      const off = onProgressEvent((event) => events.push(event));
      try {
        const req = createApprovalRequest(
          'external_comm',
          'Send external update',
          { sessionId: 'session-event', chatId: 'chat-event', required_level: 'L3_FULL_ACCESS' },
          'agent-1',
          'tenant-event',
        );

        approveRequest(req.id, 'operator-1', 'tenant-event');

        expect(events).toContainEqual(expect.objectContaining({
          type: 'approval_resolved',
          approvalRequestId: req.id,
          approvalStatus: 'approved',
          chatId: 'chat-event',
          sessionId: 'session-event',
          tenantId: 'tenant-event',
          permissionLevel: undefined,
        }));
      } finally {
        off();
      }
    });
  });

  describe('rejectRequest', () => {
    it('rejects a pending request', () => {
      const req = createApprovalRequest('external_comm', 'Send email to user');
      const rejected = rejectRequest(req.id, 'admin');

      expect(rejected.status).toBe('rejected');
      expect(rejected.resolved_by).toBe('admin');
    });

    it('throws if already resolved', () => {
      const req = createApprovalRequest('skill_register', 'test');
      rejectRequest(req.id);
      expect(() => rejectRequest(req.id)).toThrow('already');
    });

    it('supports desktop_control approval requests', () => {
      const req = createApprovalRequest('desktop_control', 'Desktop click requires approval');
      const approved = approveRequest(req.id, 'admin');
      expect(approved.action).toBe('desktop_control');
      expect(approved.status).toBe('approved');
    });

    it('does not raise session permission level when permission elevation is rejected', () => {
      const tenantId = 'tenant-gates-reject';
      const session = createSession('user-reject', 'Permission rejection', tenantId);
      updateSessionPermissionLevel(session.id, 'L1_READ_WRITE', tenantId);
      const req = createApprovalRequest(
        'permission_elevation',
        'Raise this session for network search',
        {
          sessionId: session.id,
          current_level: 'L1_READ_WRITE',
          required_level: 'L3_FULL_ACCESS',
          denied_action: 'network.request',
          tool: 'web_search',
        },
        'session:test',
        tenantId,
      );

      const rejected = rejectRequest(req.id, 'operator-1', tenantId);

      expect(rejected.status).toBe('rejected');
      expect(getSessionPermissionLevel(session.id, tenantId)).toBe('L1_READ_WRITE');
      expect(queryAuditLog({ tenant_id: tenantId, action: 'session.permission' }).entries).toHaveLength(0);
    });
  });

  describe('getRequest', () => {
    it('retrieves a request by ID', () => {
      const req = createApprovalRequest('skill_register', 'test get');
      const fetched = getRequest(req.id);
      expect(fetched).toBeTruthy();
      expect(fetched!.description).toBe('test get');
    });

    it('returns null for nonexistent ID', () => {
      expect(getRequest('nonexistent')).toBeNull();
    });
  });

  describe('getPendingRequests', () => {
    it('returns only pending requests', () => {
      const pending = getPendingRequests();
      for (const req of pending) {
        expect(req.status).toBe('pending');
      }
    });
  });

  describe('listRequests', () => {
    it('filters by action', () => {
      const results = listRequests({ action: 'skill_register' });
      for (const req of results) {
        expect(req.action).toBe('skill_register');
      }
    });

    it('filters by status', () => {
      const results = listRequests({ status: 'approved' });
      for (const req of results) {
        expect(req.status).toBe('approved');
      }
    });
  });

  describe('formatApprovalNotification', () => {
    it('formats notification with ID and commands', () => {
      const req = createApprovalRequest('skill_register', 'Register skill X');
      const notification = formatApprovalNotification(req);

      expect(notification).toContain('[APPROVAL NEEDED]');
      expect(notification).toContain('Register skill X');
      expect(notification).toContain(req.id);
      expect(notification).toContain('/approve');
      expect(notification).toContain('/reject');
    });
  });
});
