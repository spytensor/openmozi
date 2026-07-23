import { describe, expect, it } from 'vitest';
import { desktopActionFromUrl, isRuntimeResourceUrl, isSafeExternalUrl, sanitizeDesktopError } from './security.js';

describe('desktop navigation security', () => {
  const runtime = 'http://127.0.0.1:9210/';

  it('requires exact runtime origin and accepts runtime blob downloads', () => {
    expect(isRuntimeResourceUrl('http://127.0.0.1:9210/session/1', runtime)).toBe(true);
    expect(isRuntimeResourceUrl('blob:http://127.0.0.1:9210/id', runtime)).toBe(true);
    expect(isRuntimeResourceUrl('http://127.0.0.1:9210.evil.test/', runtime)).toBe(false);
    expect(isRuntimeResourceUrl('http://127.0.0.1:9211/', runtime)).toBe(false);
  });

  it('allows only browser-safe external protocols', () => {
    expect(isSafeExternalUrl('https://example.com')).toBe(true);
    expect(isSafeExternalUrl('mailto:user@example.com')).toBe(true);
    expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeExternalUrl('data:text/html,unsafe')).toBe(false);
  });

  it('parses only known status-page actions', () => {
    expect(desktopActionFromUrl('mozi-action://retry')).toBe('retry');
    expect(desktopActionFromUrl('mozi-action://restart')).toBe('restart');
    expect(desktopActionFromUrl('mozi-action://open-log')).toBe('open-log');
    expect(desktopActionFromUrl('mozi-action://delete-data')).toBeNull();
  });

  it('redacts credential values and request identifiers from startup errors', () => {
    const value = sanitizeDesktopError('invalid api_key=sk-secret Authorization: Bearer abc123 {"request_id":"req-1"}');
    expect(value).not.toContain('sk-secret');
    expect(value).not.toContain('abc123');
    expect(value).not.toContain('req-1');
    expect(value).toContain('[redacted]');
  });
});
