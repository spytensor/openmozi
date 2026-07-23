import { describe, expect, it } from 'vitest';
import {
  buildDeterministicRecoveryMessage,
  extractRecoveryErrorText,
  normalizeProviderError,
} from './error-surfacing.js';

describe('core/error-surfacing', () => {
  it('extracts nested provider quota details from wrapped retry errors', () => {
    const error = Object.assign(new Error('No output generated. Check the stream for errors.'), {
      lastError: {
        message: 'Insufficient balance or no resource package. Please recharge.',
        responseBody: '{"error":{"code":"1113","message":"Insufficient balance or no resource package. Please recharge."}}',
      },
      errors: [
        { message: '429 provider quota exceeded' },
      ],
    });

    const extracted = extractRecoveryErrorText(error);
    expect(extracted).toContain('No output generated. Check the stream for errors.');
    expect(extracted).toContain('Insufficient balance or no resource package. Please recharge.');
    expect(extracted).toContain('429 provider quota exceeded');
  });

  it('normalizes structured stream errors without collapsing them to object Object', () => {
    const error = normalizeProviderError({
      type: 'error',
      error: {
        type: 'insufficient_quota',
        code: 'insufficient_quota',
        message: 'You exceeded your current quota, please check your plan and billing details.',
      },
    });

    expect(error.message).toContain('You exceeded your current quota');
    expect(error.message).not.toContain('[object Object]');
    expect(error.kind).toBe('quota');
    expect(error.code).toBe('insufficient_quota');
    expect(error.retryable).toBe(false);
  });

  it('keeps temporary rate limits retryable and separate from exhausted quota', () => {
    const error = normalizeProviderError({
      statusCode: 429,
      message: 'Rate limit reached for requests. Please retry after a brief wait.',
    });

    expect(error.kind).toBe('rate_limit');
    expect(error.retryable).toBe(true);
    expect(buildDeterministicRecoveryMessage(error.message)).toContain('temporarily rate limited');
  });

  it('classifies numeric rate limits and network failures as retryable', () => {
    expect(normalizeProviderError(new Error('HTTP 429')).kind).toBe('rate_limit');
    const network = normalizeProviderError(Object.assign(new Error('request failed'), { code: 'EAI_AGAIN' }));
    expect(network).toMatchObject({ kind: 'transient', retryable: true });
  });

  it('maps quota-like failures to a deterministic quota message', () => {
    const result = buildDeterministicRecoveryMessage(
      'No output generated.\nInsufficient balance or no resource package. Please recharge.\n429',
    );

    expect(result).toBe(
      'Request failed because the current provider account hit a quota/balance limit. Please recharge or switch to another configured provider, then retry.',
    );
  });

  it('surfaces the actual error when no known failure pattern matches', () => {
    const result = buildDeterministicRecoveryMessage('No output generated. Check the stream for errors.');
    expect(result).toBe('Request failed: No output generated. Check the stream for errors.');
  });

  it('truncates very long error messages', () => {
    const longError = 'x'.repeat(500);
    const result = buildDeterministicRecoveryMessage(longError);
    expect(result).toContain('Request failed:');
    expect(result.length).toBeLessThan(320);
    expect(result).toContain('…');
  });

  it('classifies provider authentication failures without exposing raw JSON', () => {
    const result = buildDeterministicRecoveryMessage(
      'invalid api key {"type":"error","error":{"type":"authentication_error"},"request_id":"secret"}',
    );
    expect(result).toContain('API key is invalid');
    expect(result).not.toContain('request_id');
  });

  it('classifies token-plan rate limits as quota failures', () => {
    const result = buildDeterministicRecoveryMessage(
      'Failed after 3 attempts. rate_limit_error: 已达到 Token Plan 用量上限 (2056)',
    );
    expect(result).toContain('quota/balance limit');
    expect(result).not.toContain('rate_limit_error');
  });
});
