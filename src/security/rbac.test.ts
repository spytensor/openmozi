import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import {
  assignRole,
  getRole,
  getEffectiveRole,
  isLocalOnly,
  resolveRole,
  removeRole,
  listRoles,
  hasCommandPermission,
  checkCommandAccess,
  getAvailableCommands,
  getCommandRole,
  isValidRole,
  AccessDeniedError,
  resetTableFlag,
  ROLES,
} from './rbac.js';

let tmpDir: string;

beforeAll(() => {
  const result = setupTestDb();
  tmpDir = result.tmpDir;
  resetTableFlag();
});

afterAll(() => {
  teardownTestDb(tmpDir);
});

describe('security/rbac', () => {
  describe('isValidRole', () => {
    it('validates known roles', () => {
      expect(isValidRole('admin')).toBe(true);
      expect(isValidRole('operator')).toBe(true);
      expect(isValidRole('viewer')).toBe(true);
    });

    it('rejects unknown roles', () => {
      expect(isValidRole('superadmin')).toBe(false);
      expect(isValidRole('')).toBe(false);
    });
  });

  describe('assignRole', () => {
    it('assigns a role to a user', () => {
      const assignment = assignRole('default', 'user-1', 'admin');
      expect(assignment.user_id).toBe('user-1');
      expect(assignment.role).toBe('admin');
      expect(assignment.tenant_id).toBe('default');
    });

    it('upserts on conflict', () => {
      assignRole('default', 'user-2', 'viewer');
      const updated = assignRole('default', 'user-2', 'operator');
      expect(updated.role).toBe('operator');
    });

    it('throws for invalid role', () => {
      expect(() => assignRole('default', 'user-3', 'superadmin' as any)).toThrow('Invalid role');
    });
  });

  describe('getRole', () => {
    it('returns role assignment', () => {
      assignRole('default', 'user-get', 'viewer');
      const assignment = getRole('default', 'user-get');
      expect(assignment).not.toBeNull();
      expect(assignment!.role).toBe('viewer');
    });

    it('returns null for unassigned user', () => {
      expect(getRole('default', 'nonexistent')).toBeNull();
    });
  });

  describe('isLocalOnly', () => {
    it('returns true when server is bound to loopback (default config)', () => {
      // Default server.host is 127.0.0.1 — should be treated as local-only.
      expect(isLocalOnly()).toBe(true);
    });
  });

  describe('getEffectiveRole', () => {
    it('returns assigned role', () => {
      assignRole('default', 'user-eff', 'operator');
      expect(getEffectiveRole('default', 'user-eff')).toBe('operator');
    });

    it('defaults to viewer when other assignments exist in tenant', () => {
      // 'default' tenant already has role assignments from prior tests
      expect(getEffectiveRole('default', 'unknown-user')).toBe('viewer');
    });

    it('defaults to admin on localhost when no assignments exist (self-hosted backward compat)', () => {
      // Default server.host is 127.0.0.1 → local-only → admin for fresh setup.
      expect(getEffectiveRole('fresh-self-hosted-tenant', 'any-user')).toBe('admin');
    });
  });

  describe('resolveRole', () => {
    it('uses highest from DB and context', () => {
      assignRole('default', 'user-resolve', 'viewer');
      const role = resolveRole('default', 'user-resolve', ['operator']);
      expect(role).toBe('operator');
    });

    it('uses DB role if context roles are lower', () => {
      assignRole('default', 'user-resolve2', 'admin');
      const role = resolveRole('default', 'user-resolve2', ['viewer']);
      expect(role).toBe('admin');
    });

    it('ignores invalid context roles', () => {
      assignRole('default', 'user-resolve3', 'viewer');
      const role = resolveRole('default', 'user-resolve3', ['superadmin', 'bogus']);
      expect(role).toBe('viewer');
    });
  });

  describe('removeRole', () => {
    it('removes an assigned role', () => {
      assignRole('default', 'user-remove', 'operator');
      expect(removeRole('default', 'user-remove')).toBe(true);
      expect(getRole('default', 'user-remove')).toBeNull();
    });

    it('returns false for unassigned user', () => {
      expect(removeRole('default', 'nobody')).toBe(false);
    });
  });

  describe('listRoles', () => {
    it('lists all assignments for a tenant', () => {
      assignRole('list-tenant', 'user-a', 'admin');
      assignRole('list-tenant', 'user-b', 'viewer');
      const roles = listRoles('list-tenant');
      expect(roles.length).toBe(2);
    });
  });

  describe('hasCommandPermission', () => {
    it('admin can execute all commands', () => {
      expect(hasCommandPermission('admin', 'config')).toBe(true);
      expect(hasCommandPermission('admin', 'status')).toBe(true);
      expect(hasCommandPermission('admin', 'approve')).toBe(true);
    });

    it('operator can execute operator and viewer commands', () => {
      expect(hasCommandPermission('operator', 'approve')).toBe(true);
      expect(hasCommandPermission('operator', 'status')).toBe(true);
      expect(hasCommandPermission('operator', 'config')).toBe(false);
    });

    it('viewer can only execute viewer commands', () => {
      expect(hasCommandPermission('viewer', 'status')).toBe(true);
      expect(hasCommandPermission('viewer', 'help')).toBe(true);
      expect(hasCommandPermission('viewer', 'tasks')).toBe(true);
      expect(hasCommandPermission('viewer', 'approve')).toBe(false);
      expect(hasCommandPermission('viewer', 'config')).toBe(false);
    });

    it('unknown commands require admin', () => {
      expect(hasCommandPermission('admin', 'unknown_cmd')).toBe(true);
      expect(hasCommandPermission('viewer', 'unknown_cmd')).toBe(false);
    });
  });

  describe('checkCommandAccess', () => {
    it('allows admin to execute config', () => {
      assignRole('access-tenant', 'admin-user', 'admin');
      expect(() => checkCommandAccess('access-tenant', 'admin-user', 'config')).not.toThrow();
    });

    it('throws AccessDeniedError for viewer on config', () => {
      assignRole('access-tenant', 'viewer-user', 'viewer');
      expect(() => checkCommandAccess('access-tenant', 'viewer-user', 'config')).toThrow(AccessDeniedError);
    });

    it('considers context roles', () => {
      // No DB assignment, but context says admin
      expect(() => checkCommandAccess('access-tenant', 'ctx-user', 'config', ['admin'])).not.toThrow();
    });
  });

  describe('getAvailableCommands', () => {
    it('admin gets all commands', () => {
      const cmds = getAvailableCommands('admin');
      expect(cmds).toContain('config');
      expect(cmds).toContain('status');
      expect(cmds).toContain('approve');
    });

    it('viewer gets limited commands', () => {
      const cmds = getAvailableCommands('viewer');
      expect(cmds).toContain('status');
      expect(cmds).toContain('help');
      expect(cmds).not.toContain('config');
      expect(cmds).not.toContain('approve');
    });
  });

  describe('getCommandRole', () => {
    it('returns correct role for known commands', () => {
      expect(getCommandRole('config')).toBe('admin');
      expect(getCommandRole('approve')).toBe('operator');
      expect(getCommandRole('status')).toBe('viewer');
    });

    it('returns admin for unknown commands', () => {
      expect(getCommandRole('unknown')).toBe('admin');
    });
  });
});
