import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import {
  isValidLevel,
  getLevelOrder,
  hasPermission,
  getRequiredLevel,
  checkPermission,
  registerActionRequirement,
  PermissionDeniedError,
  PERMISSION_LEVELS,
} from './permissions.js';

let tmpDir: string;

beforeAll(() => {
  const result = setupTestDb();
  tmpDir = result.tmpDir;
});

afterAll(() => {
  teardownTestDb(tmpDir);
});

describe('security/permissions', () => {
  describe('isValidLevel', () => {
    it('returns true for all valid levels', () => {
      for (const level of PERMISSION_LEVELS) {
        expect(isValidLevel(level)).toBe(true);
      }
    });

    it('returns false for invalid levels', () => {
      expect(isValidLevel('INVALID')).toBe(false);
      expect(isValidLevel('')).toBe(false);
    });
  });

  describe('getLevelOrder', () => {
    it('returns ascending order for permission levels', () => {
      expect(getLevelOrder('L0_READ_ONLY')).toBe(0);
      expect(getLevelOrder('L1_READ_WRITE')).toBe(1);
      expect(getLevelOrder('L2_SHELL_EXEC')).toBe(2);
      expect(getLevelOrder('L3_FULL_ACCESS')).toBe(3);
    });
  });

  describe('hasPermission', () => {
    it('allows same level', () => {
      expect(hasPermission('L1_READ_WRITE', 'L1_READ_WRITE')).toBe(true);
    });

    it('allows higher level', () => {
      expect(hasPermission('L3_FULL_ACCESS', 'L0_READ_ONLY')).toBe(true);
      expect(hasPermission('L2_SHELL_EXEC', 'L1_READ_WRITE')).toBe(true);
    });

    it('denies lower level', () => {
      expect(hasPermission('L0_READ_ONLY', 'L1_READ_WRITE')).toBe(false);
      expect(hasPermission('L1_READ_WRITE', 'L2_SHELL_EXEC')).toBe(false);
    });
  });

  describe('getRequiredLevel', () => {
    it('returns correct levels for known actions', () => {
      expect(getRequiredLevel('filesystem.read')).toBe('L0_READ_ONLY');
      expect(getRequiredLevel('filesystem.write')).toBe('L1_READ_WRITE');
      expect(getRequiredLevel('shell.execute')).toBe('L2_SHELL_EXEC');
      expect(getRequiredLevel('network.read')).toBe('L2_SHELL_EXEC');
      expect(getRequiredLevel('network.request')).toBe('L3_FULL_ACCESS');
      expect(getRequiredLevel('desktop.control')).toBe('L3_FULL_ACCESS');
    });

    it('returns L3 for unknown actions (fail-close)', () => {
      expect(getRequiredLevel('unknown.action')).toBe('L3_FULL_ACCESS');
      expect(getRequiredLevel('never.registered')).toBe('L3_FULL_ACCESS');
    });
  });

  describe('registerActionRequirement', () => {
    it('registers a custom action requirement', () => {
      registerActionRequirement('custom.action', 'L2_SHELL_EXEC');
      expect(getRequiredLevel('custom.action')).toBe('L2_SHELL_EXEC');
    });
  });

  describe('checkPermission', () => {
    it('passes when agent has sufficient permission', () => {
      expect(() => {
        checkPermission('agent-1', 'L2_SHELL_EXEC', 'shell', 'execute');
      }).not.toThrow();
    });

    it('passes when agent has higher permission', () => {
      expect(() => {
        checkPermission('agent-1', 'L3_FULL_ACCESS', 'filesystem', 'read');
      }).not.toThrow();
    });

    it('throws PermissionDeniedError when insufficient', () => {
      expect(() => {
        checkPermission('agent-1', 'L0_READ_ONLY', 'shell', 'execute');
      }).toThrow(PermissionDeniedError);
    });

    it('PermissionDeniedError has correct properties', () => {
      try {
        checkPermission('agent-x', 'L0_READ_ONLY', 'filesystem', 'write');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(PermissionDeniedError);
        const pe = err as PermissionDeniedError;
        expect(pe.agentId).toBe('agent-x');
        expect(pe.agentLevel).toBe('L0_READ_ONLY');
        expect(pe.requiredLevel).toBe('L1_READ_WRITE');
        expect(pe.action).toBe('filesystem.write');
      }
    });

    it('treats invalid permission level as L0_READ_ONLY', () => {
      expect(() => {
        checkPermission('agent-1', 'INVALID', 'filesystem', 'read');
      }).not.toThrow();

      expect(() => {
        checkPermission('agent-1', 'INVALID', 'filesystem', 'write');
      }).toThrow(PermissionDeniedError);
    });

    it('denies unregistered actions unless agent has L3 (fail-close)', () => {
      // Unregistered action defaults to L3_FULL_ACCESS
      expect(() => {
        checkPermission('agent-1', 'L2_SHELL_EXEC', 'unknown', 'action');
      }).toThrow(PermissionDeniedError);

      // Only L3 can perform unregistered actions
      expect(() => {
        checkPermission('agent-1', 'L3_FULL_ACCESS', 'unknown', 'action');
      }).not.toThrow();
    });
  });
});
