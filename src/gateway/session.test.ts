import { describe, it, expect } from 'vitest';
import { createSession } from './session.js';

describe('gateway/session', () => {
  it('creates session in IDLE state', () => {
    const session = createSession();
    expect(session.state).toBe('IDLE');
    expect(session.tenantId).toBe('default');
    expect(session.id).toMatch(/^session_/);
  });

  it('valid transition: IDLE → WORKING', () => {
    const session = createSession();
    session.transition('WORKING');
    expect(session.state).toBe('WORKING');
  });

  it('valid transition: WORKING → RESPONDING', () => {
    const session = createSession();
    session.transition('WORKING');
    session.transition('RESPONDING');
    expect(session.state).toBe('RESPONDING');
  });

  it('valid transition: RESPONDING → IDLE', () => {
    const session = createSession();
    session.transition('WORKING');
    session.transition('RESPONDING');
    session.transition('IDLE');
    expect(session.state).toBe('IDLE');
  });

  it('valid transition: RESPONDING → WORKING (back-to-back)', () => {
    const session = createSession();
    session.transition('WORKING');
    session.transition('RESPONDING');
    session.transition('WORKING');
    expect(session.state).toBe('WORKING');
  });

  it('full cycle: IDLE → WORKING → RESPONDING → IDLE', () => {
    const session = createSession();
    session.transition('WORKING');
    session.transition('RESPONDING');
    session.transition('IDLE');
    expect(session.state).toBe('IDLE');
  });

  it('invalid: IDLE → RESPONDING throws', () => {
    const session = createSession();
    expect(() => session.transition('RESPONDING')).toThrow('Invalid state transition');
  });

  it('invalid: IDLE → IDLE throws', () => {
    const session = createSession();
    expect(() => session.transition('IDLE')).toThrow('Invalid state transition');
  });

  it('invalid: WORKING → IDLE throws', () => {
    const session = createSession();
    session.transition('WORKING');
    expect(() => session.transition('IDLE')).toThrow('Invalid state transition');
  });

  it('invalid: WORKING → WORKING throws', () => {
    const session = createSession();
    session.transition('WORKING');
    expect(() => session.transition('WORKING')).toThrow('Invalid state transition');
  });

  it('updatedAt changes on transition', () => {
    const session = createSession();
    const before = session.updatedAt;
    session.transition('WORKING');
    expect(session.updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  it('custom tenant_id', () => {
    const session = createSession('my-tenant');
    expect(session.tenantId).toBe('my-tenant');
  });
});
