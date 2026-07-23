import { describe, it, expect, beforeEach } from 'vitest';
import { register, get, has, listAll, remove, reset, getRetryDelay } from './sla.js';

describe('tel/sla', () => {
  beforeEach(() => {
    reset();
  });

  it('register + get', () => {
    register('shell', { timeout: 60, soft_timeout: 30, retries: 1, fallback: 'report_error' });
    const sla = get('shell');
    expect(sla.timeout).toBe(60);
    expect(sla.soft_timeout).toBe(30);
    expect(sla.retries).toBe(1);
    expect(sla.fallback).toBe('report_error');
  });

  it('unknown tool returns default SLA', () => {
    const sla = get('unknown-tool');
    expect(sla.timeout).toBe(60);
    expect(sla.retries).toBe(0);
    expect(sla.retry_strategy).toBe('immediate');
    expect(sla.sandbox).toBe('none');
  });

  it('has returns correct value', () => {
    expect(has('shell')).toBe(false);
    register('shell', { timeout: 30 });
    expect(has('shell')).toBe(true);
  });

  it('listAll returns all registered SLAs', () => {
    register('shell', { timeout: 60 });
    register('filesystem', { timeout: 30 });
    const all = listAll();
    expect(all.size).toBe(2);
    expect(all.has('shell')).toBe(true);
    expect(all.has('filesystem')).toBe(true);
  });

  it('remove deletes SLA', () => {
    register('shell', { timeout: 60 });
    expect(remove('shell')).toBe(true);
    expect(has('shell')).toBe(false);
  });

  it('remove returns false for unregistered', () => {
    expect(remove('unregistered')).toBe(false);
  });

  it('reset clears all registrations', () => {
    register('a', { timeout: 1 });
    register('b', { timeout: 2 });
    reset();
    expect(listAll().size).toBe(0);
  });

  describe('getRetryDelay', () => {
    it('immediate strategy returns 0', () => {
      expect(getRetryDelay(0, 'immediate')).toBe(0);
      expect(getRetryDelay(5, 'immediate')).toBe(0);
    });

    it('linear_backoff increases linearly', () => {
      expect(getRetryDelay(0, 'linear_backoff')).toBe(1000);
      expect(getRetryDelay(1, 'linear_backoff')).toBe(2000);
      expect(getRetryDelay(2, 'linear_backoff')).toBe(3000);
    });

    it('exponential_backoff doubles each time', () => {
      expect(getRetryDelay(0, 'exponential_backoff')).toBe(1000);
      expect(getRetryDelay(1, 'exponential_backoff')).toBe(2000);
      expect(getRetryDelay(2, 'exponential_backoff')).toBe(4000);
      expect(getRetryDelay(3, 'exponential_backoff')).toBe(8000);
    });

    it('exponential_backoff caps at 30s', () => {
      expect(getRetryDelay(10, 'exponential_backoff')).toBe(30000);
    });
  });
});
