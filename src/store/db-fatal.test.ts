import { describe, it, expect } from 'vitest';
import { isDatabaseFatalError } from './db.js';

describe('isDatabaseFatalError', () => {
  it('returns true for ENOSPC', () => {
    expect(isDatabaseFatalError(new Error('ENOSPC: no space left on device'))).toBe(true);
  });
  it('returns true for SQLITE_IOERR', () => {
    expect(isDatabaseFatalError(new Error('SQLITE_IOERR: disk I/O error'))).toBe(true);
  });
  it('returns true for SQLITE_FULL', () => {
    expect(isDatabaseFatalError(new Error('SQLITE_FULL: database or disk is full'))).toBe(true);
  });
  it('returns true for SQLITE_CORRUPT', () => {
    expect(isDatabaseFatalError(new Error('SQLITE_CORRUPT: database disk image is malformed'))).toBe(true);
  });
  it('returns true for EACCES', () => {
    expect(isDatabaseFatalError(new Error('EACCES: permission denied'))).toBe(true);
  });
  it('returns false for normal errors', () => {
    expect(isDatabaseFatalError(new Error('some random error'))).toBe(false);
  });
  it('returns false for non-Error values', () => {
    expect(isDatabaseFatalError('string error')).toBe(false);
    expect(isDatabaseFatalError(null)).toBe(false);
    expect(isDatabaseFatalError(undefined)).toBe(false);
  });
});
