import { describe, expect, it } from 'vitest';
import { hashPassword, validatePasswordPolicy, verifyPassword } from './password.js';

describe('security/password', () => {
  it('hashes and verifies a password roundtrip', async () => {
    const stored = await hashPassword('CorrectHorse1');
    expect(stored).toMatch(/^scrypt\$16384\$8\$1\$/);
    await expect(verifyPassword('CorrectHorse1', stored)).resolves.toBe(true);
  });

  it('rejects the wrong password', async () => {
    const stored = await hashPassword('CorrectHorse1');
    await expect(verifyPassword('WrongHorse1', stored)).resolves.toBe(false);
  });

  it('tolerates malformed stored values', async () => {
    await expect(verifyPassword('CorrectHorse1', '')).resolves.toBe(false);
    await expect(verifyPassword('CorrectHorse1', 'not-a-hash')).resolves.toBe(false);
    await expect(verifyPassword('CorrectHorse1', 'scrypt$16384$8$1$bad$bad')).resolves.toBe(false);
  });

  it('enforces the password policy matrix', () => {
    expect(validatePasswordPolicy('Short1')).toBe('Password must be at least 8 characters.');
    expect(validatePasswordPolicy('abcdefgh')).toBe('Password must include at least one digit.');
    expect(validatePasswordPolicy('12345678')).toBe('Password must include at least one letter.');
    expect(validatePasswordPolicy('abc12345')).toBeNull();
  });

  it('uses the timing-safe verification path for same-length mismatches', async () => {
    const stored = await hashPassword('CorrectHorse1');
    const parts = stored.split('$');
    const hash = Buffer.from(parts[5], 'base64');
    hash[0] = hash[0] ^ 0xff;
    parts[5] = hash.toString('base64');

    await expect(verifyPassword('CorrectHorse1', parts.join('$'))).resolves.toBe(false);
  });
});
