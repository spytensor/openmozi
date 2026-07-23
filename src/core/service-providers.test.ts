import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SEARCH_PROVIDERS,
  getServiceProvider,
  getServiceProvidersByCategory,
  isAnySearchProviderConfigured,
  isServiceProviderConfigured,
  resolveActiveSearchProvider,
} from './service-providers.js';

const SEARCH_ENV_VARS = ['SEARCH1API_KEY', 'TAVILY_API_KEY', 'SERPER_API_KEY', 'BRAVE_API_KEY', 'MOZI_SEARCH_PROVIDER'];

describe('service-providers registry', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of SEARCH_ENV_VARS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of SEARCH_ENV_VARS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('registers the four search providers with distinct env vars', () => {
    const ids = SEARCH_PROVIDERS.map((p) => p.id);
    expect(ids).toEqual(['search1api', 'tavily', 'serper', 'brave']);
    const envVars = new Set(SEARCH_PROVIDERS.map((p) => p.envVar));
    expect(envVars.size).toBe(4);
  });

  it('looks up providers by id and category', () => {
    expect(getServiceProvider('tavily')?.name).toBe('Tavily');
    expect(getServiceProvider('nope')).toBeUndefined();
    expect(getServiceProvidersByCategory('search')).toHaveLength(4);
  });

  it('reports configured state from the environment', () => {
    expect(isAnySearchProviderConfigured()).toBe(false);
    process.env.TAVILY_API_KEY = 'tvly-abc';
    expect(isServiceProviderConfigured(getServiceProvider('tavily')!)).toBe(true);
    expect(isAnySearchProviderConfigured()).toBe(true);
  });

  it('resolves the active provider by precedence, then explicit override', () => {
    expect(resolveActiveSearchProvider()).toBeNull();

    // First configured provider (precedence order) wins by default.
    process.env.SERPER_API_KEY = 'serper-key';
    expect(resolveActiveSearchProvider()?.id).toBe('serper');

    // A higher-precedence provider takes over when also configured.
    process.env.SEARCH1API_KEY = 's1-key';
    expect(resolveActiveSearchProvider()?.id).toBe('search1api');

    // Explicit override wins when it points at a configured provider.
    process.env.MOZI_SEARCH_PROVIDER = 'serper';
    expect(resolveActiveSearchProvider()?.id).toBe('serper');

    // Override pointing at an unconfigured provider is ignored.
    process.env.MOZI_SEARCH_PROVIDER = 'brave';
    expect(resolveActiveSearchProvider()?.id).toBe('search1api');
  });
});
