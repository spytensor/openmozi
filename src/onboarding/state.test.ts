import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import { setBootstrapState, getBootstrapState, isOnboardingCompleted, resetOnboardingState, resetTableFlag } from './state.js';

describe('onboarding state', () => {
  let tmpDir: string;

  beforeEach(() => {
    const result = setupTestDb();
    tmpDir = result.tmpDir;
    resetTableFlag();
  });

  afterEach(() => {
    teardownTestDb(tmpDir);
  });

  it('set and get bootstrap state', () => {
    setBootstrapState('test.key', 'test-value');
    expect(getBootstrapState('test.key')).toBe('test-value');
  });

  it('returns null for missing key', () => {
    expect(getBootstrapState('nonexistent')).toBeNull();
  });

  it('upserts on duplicate key', () => {
    setBootstrapState('test.key', 'v1');
    setBootstrapState('test.key', 'v2');
    expect(getBootstrapState('test.key')).toBe('v2');
  });

  it('isOnboardingCompleted returns false by default', () => {
    expect(isOnboardingCompleted()).toBe(false);
  });

  it('isOnboardingCompleted returns true when set', () => {
    setBootstrapState('onboarding.completed', 'true');
    expect(isOnboardingCompleted()).toBe(true);
  });

  it('resetOnboardingState clears all entries', () => {
    setBootstrapState('onboarding.completed', 'true');
    setBootstrapState('some.other.key', 'value');
    expect(getBootstrapState('onboarding.completed')).toBe('true');

    resetOnboardingState();

    expect(getBootstrapState('onboarding.completed')).toBeNull();
    expect(getBootstrapState('some.other.key')).toBeNull();
    expect(isOnboardingCompleted()).toBe(false);
  });

  it('resetOnboardingState works when table is empty', () => {
    // Should not throw
    resetOnboardingState();
    expect(getBootstrapState('anything')).toBeNull();
  });
});
