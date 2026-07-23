import { describe, it, expect, beforeEach } from 'vitest';
import { reportSuccess, reportFailure, getStatus, getHealth, reset } from './provider-health.js';

describe('core/provider-health', () => {
  beforeEach(() => {
    reset('test-provider');
  });

  it('unknown provider defaults to healthy', () => {
    expect(getStatus('never-seen-provider')).toBe('healthy');
  });

  it('stays healthy with successes', () => {
    reportSuccess('test-provider', 100);
    reportSuccess('test-provider', 200);
    expect(getStatus('test-provider')).toBe('healthy');
  });

  it('degrades after 2 consecutive failures', () => {
    reportFailure('test-provider');
    expect(getStatus('test-provider')).toBe('healthy');
    reportFailure('test-provider');
    expect(getStatus('test-provider')).toBe('degraded');
  });

  it('goes down after 3 consecutive failures', () => {
    reportFailure('test-provider');
    reportFailure('test-provider');
    reportFailure('test-provider');
    expect(getStatus('test-provider')).toBe('down');
  });

  it('success resets consecutive failure count', () => {
    reportFailure('test-provider');
    reportSuccess('test-provider');
    reportFailure('test-provider');
    // Only 1 consecutive failure, not 2
    expect(getStatus('test-provider')).toBe('healthy');
  });

  it('recovery: down → degraded after 2 successes', () => {
    reportFailure('test-provider');
    reportFailure('test-provider');
    reportFailure('test-provider');
    expect(getStatus('test-provider')).toBe('down');

    reportSuccess('test-provider');
    expect(getStatus('test-provider')).toBe('down'); // Not yet
    reportSuccess('test-provider');
    expect(getStatus('test-provider')).toBe('degraded');
  });

  it('recovery: degraded → healthy after 2 successes', () => {
    reportFailure('test-provider');
    reportFailure('test-provider');
    expect(getStatus('test-provider')).toBe('degraded');

    reportSuccess('test-provider');
    expect(getStatus('test-provider')).toBe('degraded'); // Not yet
    reportSuccess('test-provider');
    expect(getStatus('test-provider')).toBe('healthy');
  });

  it('full recovery: down → degraded → healthy', () => {
    // Go down
    reportFailure('test-provider');
    reportFailure('test-provider');
    reportFailure('test-provider');
    expect(getStatus('test-provider')).toBe('down');

    // Recover to degraded
    reportSuccess('test-provider');
    reportSuccess('test-provider');
    expect(getStatus('test-provider')).toBe('degraded');

    // Recover to healthy
    reportSuccess('test-provider');
    reportSuccess('test-provider');
    expect(getStatus('test-provider')).toBe('healthy');
  });

  it('getHealth returns detailed info', () => {
    reportSuccess('test-provider', 150);
    reportSuccess('test-provider', 250);
    const health = getHealth('test-provider');

    expect(health.status).toBe('healthy');
    expect(health.consecutiveFailures).toBe(0);
    expect(health.lastSuccess).toBeInstanceOf(Date);
    expect(health.lastFailure).toBeNull();
    expect(health.avgLatencyMs).toBe(200); // (150+250)/2
  });

  it('getHealth tracks failure details', () => {
    reportFailure('test-provider');
    const health = getHealth('test-provider');
    expect(health.consecutiveFailures).toBe(1);
    expect(health.lastFailure).toBeInstanceOf(Date);
  });

  it('reset clears provider state', () => {
    reportFailure('test-provider');
    reportFailure('test-provider');
    reportFailure('test-provider');
    expect(getStatus('test-provider')).toBe('down');

    reset('test-provider');
    expect(getStatus('test-provider')).toBe('healthy');
  });
});
