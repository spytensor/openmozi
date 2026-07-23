import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  createCliAdapterMock: vi.fn(() => ({
    provider: 'cli-mock',
    chat: vi.fn(),
    chatStream: vi.fn(),
  })),
  resolveCliOAuthKeyMock: vi.fn(),
}));

vi.mock('./llm-cli.js', () => ({
  createCliAdapter: hoisted.createCliAdapterMock,
}));

vi.mock('./cli-credentials.js', () => ({
  resolveCliOAuthKey: hoisted.resolveCliOAuthKeyMock,
}));

import { create } from './llm.js';

describe('core/llm cli-pipe routing', () => {
  beforeEach(() => {
    delete process.env.MOZI_CLI_OAUTH_DIRECT_API;
    hoisted.createCliAdapterMock.mockClear();
    hoisted.resolveCliOAuthKeyMock.mockReset();
  });

  it('defaults to CLI subprocess and does not attempt OAuth direct API', () => {
    hoisted.resolveCliOAuthKeyMock.mockReturnValue({
      accessToken: 'oauth-token',
      apiMode: 'openai-compat',
      baseUrl: 'https://api.openai.com/v1',
    });

    const client = create('codex-cli', { model: 'gpt-5.3-codex' });

    expect(client.provider).toBe('cli-mock');
    expect(hoisted.createCliAdapterMock).toHaveBeenCalledTimes(1);
    expect(hoisted.resolveCliOAuthKeyMock).not.toHaveBeenCalled();
  });

  it('uses OAuth direct API only when explicitly enabled', () => {
    process.env.MOZI_CLI_OAUTH_DIRECT_API = '1';
    hoisted.resolveCliOAuthKeyMock.mockReturnValue({
      accessToken: 'oauth-token',
      apiMode: 'openai-compat',
      baseUrl: 'https://api.openai.com/v1',
    });

    const client = create('codex-cli', { model: 'gpt-5.3-codex' });

    expect(client.provider).toBe('codex-cli');
    expect(hoisted.resolveCliOAuthKeyMock).toHaveBeenCalledTimes(1);
    expect(hoisted.createCliAdapterMock).not.toHaveBeenCalled();
  });

  it('falls back to CLI subprocess when direct API is enabled but OAuth is unavailable', () => {
    process.env.MOZI_CLI_OAUTH_DIRECT_API = 'true';
    hoisted.resolveCliOAuthKeyMock.mockReturnValue(null);

    const client = create('claude-cli', { model: 'claude-sonnet-4-6' });

    expect(client.provider).toBe('cli-mock');
    expect(hoisted.resolveCliOAuthKeyMock).toHaveBeenCalledWith('claude-cli');
    expect(hoisted.createCliAdapterMock).toHaveBeenCalledTimes(1);
  });
});
