import { afterEach, describe, expect, it } from 'vitest';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import {
  addAllowedUser,
  approvePairingRequest,
  createPairingRequest,
  createPairingToken,
  getAllowedUsers,
  hasAnyPairedUsers,
  isAllowed,
  resetTableFlag,
  validatePairingToken,
} from './pairing.js';

let tmpDir: string | null = null;

afterEach(() => {
  resetTableFlag();
  if (tmpDir) {
    teardownTestDb(tmpDir);
    tmpDir = null;
  }
});

describe('pairing tenant isolation', () => {
  it('keeps allowed users and pairing tokens scoped by tenant', () => {
    ({ tmpDir } = setupTestDb());

    addAllowedUser('user-1', 'alice', 'owner', 'tenant-a');
    expect(hasAnyPairedUsers('tenant-a')).toBe(true);
    expect(hasAnyPairedUsers('tenant-b')).toBe(false);
    expect(isAllowed('user-1', 'tenant-a')).toBe(true);
    expect(isAllowed('user-1', 'tenant-b')).toBe(false);
    expect(getAllowedUsers('tenant-b')).toEqual([]);

    const token = createPairingToken('user', 30, 'tenant-a');
    expect(validatePairingToken(token, 'tenant-b')).toBeNull();
    expect(validatePairingToken(token, 'tenant-a')).toBe('user');
    expect(validatePairingToken(token, 'tenant-a')).toBeNull();
  });

  it('approves short-code pairing requests only in their tenant', () => {
    ({ tmpDir } = setupTestDb());

    const request = createPairingRequest('user-2', 'bob', 'telegram', 'tenant-a');
    expect(request).not.toBeNull();

    expect(approvePairingRequest(request!.code, 'owner', 'tenant-b')).toBeNull();
    expect(isAllowed('user-2', 'tenant-b')).toBe(false);

    const approved = approvePairingRequest(request!.code, 'owner', 'tenant-a');
    expect(approved).toMatchObject({ userId: 'user-2', username: 'bob' });
    expect(isAllowed('user-2', 'tenant-a')).toBe(true);
    expect(isAllowed('user-2', 'tenant-b')).toBe(false);
  });
});
