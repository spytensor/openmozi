import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  checkSSRF,
  checkSSRFSync,
  configure,
  DEFAULT_SSRF_CONFIG,
  ssrfSafeFetch,
} from './ssrf-guard.js';

describe('security/ssrf-guard', () => {
  beforeEach(() => {
    configure({ ...DEFAULT_SSRF_CONFIG });
  });

  describe('checkSSRFSync', () => {
    it('allows normal external URLs', () => {
      expect(checkSSRFSync('https://example.com').safe).toBe(true);
      expect(checkSSRFSync('https://github.com/repo').safe).toBe(true);
      expect(checkSSRFSync('http://api.search1api.com/search').safe).toBe(true);
    });

    it('blocks localhost', () => {
      const result = checkSSRFSync('http://localhost:8080/admin');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('localhost');
    });

    it('blocks 127.0.0.1 loopback', () => {
      const result = checkSSRFSync('http://127.0.0.1:6379/');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('private');
    });

    it('blocks AWS metadata endpoint IP', () => {
      const result = checkSSRFSync('http://169.254.169.254/latest/meta-data/');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('private');
    });

    it('blocks RFC 1918 Class A (10.x.x.x)', () => {
      expect(checkSSRFSync('http://10.0.0.1/api').safe).toBe(false);
      expect(checkSSRFSync('http://10.255.255.255/').safe).toBe(false);
    });

    it('blocks RFC 1918 Class B (172.16-31.x.x)', () => {
      expect(checkSSRFSync('http://172.16.0.1/').safe).toBe(false);
      expect(checkSSRFSync('http://172.31.255.255/').safe).toBe(false);
    });

    it('blocks RFC 1918 Class C (192.168.x.x)', () => {
      expect(checkSSRFSync('http://192.168.1.1/admin').safe).toBe(false);
      expect(checkSSRFSync('http://192.168.0.100:3000/').safe).toBe(false);
    });

    it('blocks GCP metadata hostname', () => {
      const result = checkSSRFSync('http://metadata.google.internal/computeMetadata/v1/');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('metadata');
    });

    it('blocks non-http protocols', () => {
      expect(checkSSRFSync('ftp://files.internal/data').safe).toBe(false);
      expect(checkSSRFSync('file:///etc/passwd').safe).toBe(false);
      expect(checkSSRFSync('gopher://evil.com/').safe).toBe(false);
    });

    it('rejects invalid URLs', () => {
      expect(checkSSRFSync('not-a-url').safe).toBe(false);
      expect(checkSSRFSync('').safe).toBe(false);
    });

    it('rejects credentials embedded in URLs', () => {
      const result = checkSSRFSync('https://user:secret@example.com/private');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('credentials');
    });

    it('allows whitelisted internal hosts', () => {
      configure({ ...DEFAULT_SSRF_CONFIG, allowed_internal_hosts: ['internal-api.local'] });
      expect(checkSSRFSync('http://internal-api.local/health').safe).toBe(true);
    });

    it('passes all URLs when protection is disabled', () => {
      configure({ ...DEFAULT_SSRF_CONFIG, enabled: false });
      expect(checkSSRFSync('http://localhost:8080').safe).toBe(true);
      expect(checkSSRFSync('http://169.254.169.254/').safe).toBe(true);
      expect(checkSSRFSync('http://10.0.0.1/secret').safe).toBe(true);
    });

    it('allows public IPs not in private ranges', () => {
      expect(checkSSRFSync('http://8.8.8.8/').safe).toBe(true);
      expect(checkSSRFSync('http://1.1.1.1/dns-query').safe).toBe(true);
    });
  });

  describe('IPv4-mapped IPv6 addresses', () => {
    it('blocks ::ffff:127.0.0.1 (loopback)', () => {
      const result = checkSSRFSync('http://[::ffff:127.0.0.1]:8080/');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('private');
    });

    it('blocks ::ffff:192.168.1.1 (RFC 1918)', () => {
      const result = checkSSRFSync('http://[::ffff:192.168.1.1]/');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('private');
    });

    it('blocks ::ffff:169.254.169.254 (metadata)', () => {
      const result = checkSSRFSync('http://[::ffff:169.254.169.254]/latest/');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('private');
    });

    it('allows ::ffff:8.8.8.8 (public IP)', () => {
      const result = checkSSRFSync('http://[::ffff:8.8.8.8]/');
      expect(result.safe).toBe(true);
    });
  });

  describe('checkSSRF (async)', () => {
    it('allows normal external URLs', async () => {
      const result = await checkSSRF('https://example.com');
      expect(result.safe).toBe(true);
    });

    it('blocks localhost', async () => {
      const result = await checkSSRF('http://localhost:3000');
      expect(result.safe).toBe(false);
    });

    it('blocks private IPs', async () => {
      const result = await checkSSRF('http://10.0.0.1/secret');
      expect(result.safe).toBe(false);
    });

    it('blocks metadata endpoint IPs', async () => {
      const result = await checkSSRF('http://169.254.169.254/latest/');
      expect(result.safe).toBe(false);
    });

    it('blocks non-http protocols', async () => {
      const result = await checkSSRF('file:///etc/passwd');
      expect(result.safe).toBe(false);
    });
  });

  describe('ssrfSafeFetch', () => {
    it('blocks a redirect from a public URL to a private address', async () => {
      const fetchImpl = vi.fn(async () => new Response(null, {
        status: 302,
        headers: { location: 'http://127.0.0.1/admin' },
      }));

      await expect(ssrfSafeFetch('http://8.8.8.8/start', {}, { fetchImpl }))
        .rejects.toThrow('Redirect blocked by SSRF protection');
      expect(fetchImpl).toHaveBeenCalledOnce();
    });

    it('strips credentials when a redirect changes origin', async () => {
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(new Response(null, {
          status: 302,
          headers: { location: 'http://1.1.1.1/final' },
        }))
        .mockResolvedValueOnce(new Response('ok', { status: 200 }));

      const response = await ssrfSafeFetch('http://8.8.8.8/start', {
        headers: {
          Authorization: 'Bearer secret',
          Cookie: 'session=secret',
          'X-API-KEY': 'secret-key',
          'X-Auth-Token': 'secret-token',
          Accept: 'text/plain',
        },
      }, { fetchImpl });

      expect(await response.text()).toBe('ok');
      const redirectedInit = fetchImpl.mock.calls[1][1] as RequestInit;
      const headers = new Headers(redirectedInit.headers);
      expect(headers.get('authorization')).toBeNull();
      expect(headers.get('cookie')).toBeNull();
      expect(headers.get('x-api-key')).toBeNull();
      expect(headers.get('x-auth-token')).toBeNull();
      expect(headers.get('accept')).toBe('text/plain');
    });

    it('does not replay a request body across origins on 307 redirects', async () => {
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(new Response(null, {
          status: 307,
          headers: { location: 'http://1.1.1.1/collect' },
        }));

      await expect(ssrfSafeFetch('http://8.8.8.8/start', {
        method: 'POST',
        body: JSON.stringify({ api_key: 'secret' }),
      }, { fetchImpl })).rejects.toThrow('Cross-origin redirect blocked for POST request');
      expect(fetchImpl).toHaveBeenCalledOnce();
    });

    it('stops redirect loops at the configured limit', async () => {
      const fetchImpl = vi.fn(async () => new Response(null, {
        status: 307,
        headers: { location: 'http://8.8.8.8/again' },
      }));

      await expect(ssrfSafeFetch('http://8.8.8.8/start', {}, { fetchImpl, maxRedirects: 1 }))
        .rejects.toThrow('Too many redirects');
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
  });
});
