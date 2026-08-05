/**
 * Pure-function tests for the provider-scoped entitlement key + matcher.
 *
 * These intentionally avoid resolveAllowedModels / the DB so they run in
 * environments where the native SQLite module is unavailable. The DB-backed
 * resolution rules are covered in entitlements.test.ts.
 */

import { describe, it, expect } from 'vitest';
import {
  makeModelEntitlementKey,
  modelEntitlementAllowed,
  modelAllowedForAnyProvider,
} from './entitlements.js';

describe('security/entitlement-key', () => {
  it('composes a provider-scoped key from provider and model', () => {
    expect(makeModelEntitlementKey('deepseek', 'deepseek-v4-flash')).toBe('deepseek:deepseek-v4-flash');
  });

  it('keeps the same model id independent across providers (the reported bug)', () => {
    // Both providers expose `deepseek-v4-flash`; only DeepSeek's is allowed.
    const allowed = [makeModelEntitlementKey('deepseek', 'deepseek-v4-flash')];
    expect(modelEntitlementAllowed(allowed, 'deepseek', 'deepseek-v4-flash')).toBe(true);
    expect(modelEntitlementAllowed(allowed, 'dashscope', 'deepseek-v4-flash')).toBe(false);
  });

  it('treats null as unrestricted', () => {
    expect(modelEntitlementAllowed(null, 'deepseek', 'x')).toBe(true);
    expect(modelAllowedForAnyProvider(null, 'x')).toBe(true);
  });

  it('accepts legacy bare-id entries under any provider (backward compat)', () => {
    const legacy = ['deepseek-v4-flash'];
    expect(modelEntitlementAllowed(legacy, 'deepseek', 'deepseek-v4-flash')).toBe(true);
    expect(modelEntitlementAllowed(legacy, 'dashscope', 'deepseek-v4-flash')).toBe(true);
  });

  it('rejects a model absent from a non-empty allow-list', () => {
    const allowed = [makeModelEntitlementKey('deepseek', 'deepseek-v4-flash')];
    expect(modelEntitlementAllowed(allowed, 'deepseek', 'other-model')).toBe(false);
  });

  it('handles model ids that themselves contain a colon', () => {
    const modelId = 'anthropic.claude-3-5-sonnet-20241022-v2:0';
    const allowed = [makeModelEntitlementKey('bedrock', modelId)];
    expect(allowed[0]).toBe(`bedrock:${modelId}`);
    expect(modelEntitlementAllowed(allowed, 'bedrock', modelId)).toBe(true);
    expect(modelEntitlementAllowed(allowed, 'openai', modelId)).toBe(false);
  });

  describe('modelAllowedForAnyProvider (provider-less coarse check)', () => {
    it('matches a composite entry by its model suffix', () => {
      const allowed = [makeModelEntitlementKey('deepseek', 'deepseek-v4-flash')];
      expect(modelAllowedForAnyProvider(allowed, 'deepseek-v4-flash')).toBe(true);
      expect(modelAllowedForAnyProvider(allowed, 'unrelated')).toBe(false);
    });

    it('matches a legacy bare entry', () => {
      expect(modelAllowedForAnyProvider(['gpt-4.1'], 'gpt-4.1')).toBe(true);
    });
  });
});
