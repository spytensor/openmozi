/**
 * Snapshot tests for llm-surface.ts — asserts the exact ChatOptions produced
 * for each surface so any policy drift is caught at the test boundary.
 */

import { describe, it, expect } from 'vitest';
import { defaultChatOptionsForSurface } from './llm-surface.js';

const BILLING_CTX = {
  tenantId: 'tenant-1',
  userId: 'user-9',
  taskId: 'task-42',
  agentId: 'agent-7',
};

describe('defaultChatOptionsForSurface', () => {
  // ---- brain_stream -------------------------------------------------------
  describe('brain_stream', () => {
    it('produces interactive scope with 5-min timeout and billing', () => {
      const opts = defaultChatOptionsForSurface('brain_stream', BILLING_CTX);
      expect(opts.execution_scope).toBe('interactive');
      expect(opts.timeout_ms).toBe(300_000);
      expect(opts.billing).toEqual({ tenantId: 'tenant-1', userId: 'user-9', taskId: 'task-42', agentId: 'agent-7' });
    });

    it('passes through caller max_tokens and temperature', () => {
      const opts = defaultChatOptionsForSurface('brain_stream', { ...BILLING_CTX, max_tokens: 8000, temperature: 0.5 });
      expect(opts.max_tokens).toBe(8000);
      expect(opts.temperature).toBe(0.5);
    });

    it('omits billing when tenantId is not provided', () => {
      const opts = defaultChatOptionsForSurface('brain_stream', {});
      expect(opts.billing).toBeUndefined();
      expect(opts.execution_scope).toBe('interactive');
    });

    it('passes through abort_signal', () => {
      const ac = new AbortController();
      const opts = defaultChatOptionsForSurface('brain_stream', { abort_signal: ac.signal });
      expect(opts.abort_signal).toBe(ac.signal);
    });
  });

  // ---- brain_nonstream ----------------------------------------------------
  describe('brain_nonstream', () => {
    it('matches brain_stream policy (interactive, 5-min, billing)', () => {
      const stream = defaultChatOptionsForSurface('brain_stream', BILLING_CTX);
      const nonStream = defaultChatOptionsForSurface('brain_nonstream', BILLING_CTX);
      expect(nonStream.execution_scope).toBe(stream.execution_scope);
      expect(nonStream.timeout_ms).toBe(stream.timeout_ms);
      expect(nonStream.billing).toEqual(stream.billing);
    });
  });

  // ---- dag_step -----------------------------------------------------------
  describe('dag_step', () => {
    it('produces worker scope (not interactive) with billing — blueprint gap fix', () => {
      const opts = defaultChatOptionsForSurface('dag_step', BILLING_CTX);
      // Blueprint: dag_step was missing execution_scope and billing.
      expect(opts.execution_scope).toBe('worker');
      expect(opts.billing).toEqual({ tenantId: 'tenant-1', userId: 'user-9', taskId: 'task-42', agentId: 'agent-7' });
    });

    it('uses 5-min timeout (same cap as brain — DAG steps can be long)', () => {
      const opts = defaultChatOptionsForSurface('dag_step', BILLING_CTX);
      expect(opts.timeout_ms).toBe(300_000);
    });

    it('passes through think setting', () => {
      const opts = defaultChatOptionsForSurface('dag_step', { ...BILLING_CTX, think: 'high' });
      expect(opts.think).toBe('high');
    });
  });

  // ---- plan_summary -------------------------------------------------------
  describe('plan_summary', () => {
    it('produces background scope with 45s timeout and low temperature', () => {
      const opts = defaultChatOptionsForSurface('plan_summary', BILLING_CTX);
      expect(opts.execution_scope).toBe('background');
      expect(opts.timeout_ms).toBe(45_000);
      expect(opts.temperature).toBe(0.3);
    });

    it('defaults max_tokens to 1200 (reasoning tokens share the cap — G3)', () => {
      const opts = defaultChatOptionsForSurface('plan_summary', BILLING_CTX);
      expect(opts.max_tokens).toBe(1200);
    });

    it('caller can override max_tokens', () => {
      const opts = defaultChatOptionsForSurface('plan_summary', { ...BILLING_CTX, max_tokens: 500 });
      expect(opts.max_tokens).toBe(500);
    });
  });

  // ---- recovery -----------------------------------------------------------
  describe('recovery', () => {
    it('produces background scope with 30s timeout and NO abort_signal', () => {
      // Recovery must not carry the original turn abort signal.
      const ac = new AbortController();
      const opts = defaultChatOptionsForSurface('recovery', { ...BILLING_CTX, abort_signal: ac.signal });
      expect(opts.execution_scope).toBe('background');
      expect(opts.timeout_ms).toBe(30_000);
      // Recovery deliberately ignores abort_signal — it outlasts the original turn.
      expect(opts.abort_signal).toBeUndefined();
    });
  });

  // ---- background_job -----------------------------------------------------
  describe('background_job', () => {
    it('produces worker scope with tenant billing — blueprint gap fix', () => {
      const opts = defaultChatOptionsForSurface('background_job', BILLING_CTX);
      // Blueprint: background_job was missing execution_scope and billing.
      expect(opts.execution_scope).toBe('worker');
      expect(opts.billing).toEqual({ tenantId: 'tenant-1', userId: 'user-9', taskId: 'task-42', agentId: 'agent-7' });
    });

    it('uses 120s timeout (shorter than brain — queue jobs have softer SLA)', () => {
      const opts = defaultChatOptionsForSurface('background_job', BILLING_CTX);
      expect(opts.timeout_ms).toBe(120_000);
    });

    it('defaults max_tokens to 4096 and temperature to 0.7', () => {
      const opts = defaultChatOptionsForSurface('background_job', {});
      expect(opts.max_tokens).toBe(4096);
      expect(opts.temperature).toBe(0.7);
    });
  });

  // ---- proactive ----------------------------------------------------------
  describe('proactive', () => {
    it('produces background scope with 30s timeout and low default temperature', () => {
      const opts = defaultChatOptionsForSurface('proactive', BILLING_CTX);
      expect(opts.execution_scope).toBe('background');
      expect(opts.timeout_ms).toBe(30_000);
      expect(opts.temperature).toBe(0.3);
    });
  });

  // ---- Cross-surface invariants -------------------------------------------
  describe('cross-surface invariants', () => {
    const surfaces = [
      'brain_stream', 'brain_nonstream', 'dag_step', 'plan_summary',
      'recovery', 'background_job', 'proactive',
    ] as const;

    it('every surface returns a non-null ChatOptions object', () => {
      for (const surface of surfaces) {
        const opts = defaultChatOptionsForSurface(surface, BILLING_CTX);
        expect(opts).toBeTruthy();
        expect(typeof opts).toBe('object');
      }
    });

    it('every surface has an execution_scope set', () => {
      for (const surface of surfaces) {
        const opts = defaultChatOptionsForSurface(surface, BILLING_CTX);
        expect(opts.execution_scope, `${surface} must set execution_scope`).toBeDefined();
      }
    });

    it('every surface has a timeout_ms set', () => {
      for (const surface of surfaces) {
        const opts = defaultChatOptionsForSurface(surface, BILLING_CTX);
        expect(typeof opts.timeout_ms, `${surface} must set timeout_ms`).toBe('number');
        expect(opts.timeout_ms!, `${surface} timeout must be positive`).toBeGreaterThan(0);
      }
    });

    it('interactive surfaces produce billing; background surfaces that receive tenantId also produce billing', () => {
      const interactiveSurfaces = ['brain_stream', 'brain_nonstream'] as const;
      for (const surface of interactiveSurfaces) {
        const opts = defaultChatOptionsForSurface(surface, BILLING_CTX);
        expect(opts.billing?.tenantId, `${surface} must have billing.tenantId`).toBe('tenant-1');
      }
    });
  });
});
