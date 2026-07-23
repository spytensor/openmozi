import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  readClaudeCliCredentials,
  readCodexCliCredentials,
  resolveCliOAuthKey,
  clearCredentialCache,
} from './cli-credentials.js';

// Mock fs.readFileSync to avoid reading real credential files
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, readFileSync: vi.fn() };
});

import { readFileSync } from 'node:fs';
const mockReadFileSync = vi.mocked(readFileSync);

describe('cli-credentials', () => {
  beforeEach(() => {
    clearCredentialCache();
    mockReadFileSync.mockReset();
  });

  afterEach(() => {
    clearCredentialCache();
  });

  describe('readClaudeCliCredentials', () => {
    const expectedPath = join(homedir(), '.claude', '.credentials.json');

    it('reads valid Claude credentials', () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({
        claudeAiOauth: {
          accessToken: 'sk-ant-test-token',
          refreshToken: 'rt-test',
          expiresAt: Date.now() + 3600_000,
        },
      }));

      const result = readClaudeCliCredentials();
      expect(result).toEqual({
        accessToken: 'sk-ant-test-token',
        refreshToken: 'rt-test',
        expiresAt: expect.any(Number),
      });
      expect(mockReadFileSync).toHaveBeenCalledWith(expectedPath, 'utf-8');
    });

    it('returns null when file is missing', () => {
      mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
      expect(readClaudeCliCredentials()).toBeNull();
    });

    it('returns null for malformed JSON', () => {
      mockReadFileSync.mockReturnValue('not json{{{');
      expect(readClaudeCliCredentials()).toBeNull();
    });

    it('returns null when accessToken is missing', () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({ claudeAiOauth: {} }));
      expect(readClaudeCliCredentials()).toBeNull();
    });

    it('returns credentials even if token is expired (reader does not filter)', () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({
        claudeAiOauth: {
          accessToken: 'expired-token',
          expiresAt: Date.now() - 3600_000,
        },
      }));
      const result = readClaudeCliCredentials();
      expect(result).not.toBeNull();
      expect(result!.accessToken).toBe('expired-token');
    });

    it('uses cache on second read within TTL', () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({
        claudeAiOauth: { accessToken: 'cached-token' },
      }));

      const first = readClaudeCliCredentials();
      const second = readClaudeCliCredentials();

      expect(first).toEqual(second);
      expect(mockReadFileSync).toHaveBeenCalledTimes(1);
    });
  });

  describe('readCodexCliCredentials', () => {
    const expectedPath = join(homedir(), '.codex', 'auth.json');

    it('reads valid Codex credentials', () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({
        tokens: {
          access_token: 'oai-test-token',
          refresh_token: 'oai-rt',
        },
      }));

      const result = readCodexCliCredentials();
      expect(result).toEqual({
        accessToken: 'oai-test-token',
        refreshToken: 'oai-rt',
      });
      expect(mockReadFileSync).toHaveBeenCalledWith(expectedPath, 'utf-8');
    });

    it('returns null when file is missing', () => {
      mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
      expect(readCodexCliCredentials()).toBeNull();
    });

    it('returns null for malformed JSON', () => {
      mockReadFileSync.mockReturnValue('{bad');
      expect(readCodexCliCredentials()).toBeNull();
    });

    it('returns null when access_token is missing', () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({ tokens: {} }));
      expect(readCodexCliCredentials()).toBeNull();
    });
  });

  describe('resolveCliOAuthKey', () => {
    it('resolves claude-cli to anthropic config', () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({
        claudeAiOauth: { accessToken: 'claude-token' },
      }));

      const result = resolveCliOAuthKey('claude-cli');
      expect(result).toEqual({
        accessToken: 'claude-token',
        apiMode: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
      });
    });

    it('resolves codex-cli to openai config', () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({
        tokens: { access_token: 'codex-token' },
      }));

      const result = resolveCliOAuthKey('codex-cli');
      expect(result).toEqual({
        accessToken: 'codex-token',
        apiMode: 'openai-compat',
        baseUrl: 'https://api.openai.com/v1',
      });
    });

    it('returns null for gemini-cli (not supported)', () => {
      expect(resolveCliOAuthKey('gemini-cli')).toBeNull();
    });

    it('returns null for unknown provider', () => {
      expect(resolveCliOAuthKey('some-other')).toBeNull();
    });

    it('returns null when credentials are missing', () => {
      mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
      expect(resolveCliOAuthKey('claude-cli')).toBeNull();
    });

    it('returns null when token is expired', () => {
      const expiredAt = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago (seconds)
      mockReadFileSync.mockReturnValue(JSON.stringify({
        claudeAiOauth: {
          accessToken: 'expired-token',
          expiresAt: expiredAt,
        },
      }));

      const result = resolveCliOAuthKey('claude-cli');
      expect(result).toBeNull();
    });

    it('returns null when token is about to expire within buffer', () => {
      const expiresInTwoMin = Math.floor(Date.now() / 1000) + 120; // 2 minutes from now (< 5 min buffer)
      mockReadFileSync.mockReturnValue(JSON.stringify({
        claudeAiOauth: {
          accessToken: 'soon-expired-token',
          expiresAt: expiresInTwoMin,
        },
      }));

      const result = resolveCliOAuthKey('claude-cli');
      expect(result).toBeNull();
    });

    it('returns credentials when token is valid and not near expiry', () => {
      const expiresInOneHour = Math.floor(Date.now() / 1000) + 3600;
      mockReadFileSync.mockReturnValue(JSON.stringify({
        claudeAiOauth: {
          accessToken: 'valid-token',
          expiresAt: expiresInOneHour,
        },
      }));

      const result = resolveCliOAuthKey('claude-cli');
      expect(result).not.toBeNull();
      expect(result!.accessToken).toBe('valid-token');
    });

    it('returns credentials when no expiresAt is set', () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({
        claudeAiOauth: { accessToken: 'no-expiry-token' },
      }));

      const result = resolveCliOAuthKey('claude-cli');
      expect(result).not.toBeNull();
      expect(result!.accessToken).toBe('no-expiry-token');
    });
  });
});
