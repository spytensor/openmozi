import { describe, it, expect } from 'vitest';
import {
  createBrief,
  validateEnvelope,
  createRpcRequest,
  createRpcResponse,
  createRpcNotification,
  createPeerRequest,
  createPeerResponse,
  createBroadcast,
  createCapabilityAd,
  TaskBriefSchema,
  ResultEnvelopeSchema,
} from './protocol.js';

describe('agents/protocol', () => {
  describe('TaskBrief', () => {
    it('creates valid brief with defaults', () => {
      const brief = createBrief({
        task_id: 'task_001',
        objective: 'Create a file',
      });

      expect(brief.task_id).toBe('task_001');
      expect(brief.objective).toBe('Create a file');
      expect(brief.done_criteria).toBe('');
      expect(brief.constraints.token_budget).toBe(10000);
      expect(brief.constraints.timeout_seconds).toBe(300);
      expect(brief.constraints.permission_level).toBe('L0_READ_ONLY');
      expect(brief.hints.complexity).toBe('medium');
      expect(brief.hints.type).toBe('general');
    });

    it('creates brief with custom constraints', () => {
      const brief = createBrief({
        task_id: 'task_002',
        objective: 'Complex task',
        done_criteria: 'File exists',
        constraints: {
          timeout_seconds: 30,
          permission_level: 'L1_READ_WRITE',
        },
      });

      expect(brief.constraints.timeout_seconds).toBe(30);
      expect(brief.constraints.permission_level).toBe('L1_READ_WRITE');
    });

    it('rejects missing required fields', () => {
      expect(() => createBrief({ task_id: 'x' } as any)).toThrow();
      expect(() => createBrief({ objective: 'y' } as any)).toThrow();
    });
  });

  describe('ResultEnvelope', () => {
    it('validates valid envelope', () => {
      const envelope = validateEnvelope({
        task_id: 'task_001',
        status: 'success',
        output: ['file://hello.txt'],
        summary: 'Created hello.txt',
        cost: { tokens: 150, tool_calls: 1, elapsed_time: 2000 },
      });

      expect(envelope.task_id).toBe('task_001');
      expect(envelope.status).toBe('success');
      expect(envelope.output).toEqual(['file://hello.txt']);
    });

    it('validates with defaults', () => {
      const envelope = validateEnvelope({
        task_id: 'task_002',
        status: 'failed',
      });

      expect(envelope.output).toEqual([]);
      expect(envelope.summary).toBe('');
      expect(envelope.cost.tokens).toBe(0);
      expect(envelope.issues).toEqual([]);
    });

    it('rejects invalid status', () => {
      expect(() =>
        validateEnvelope({ task_id: 'task_001', status: 'invalid' })
      ).toThrow();
    });

    it('rejects missing task_id', () => {
      expect(() =>
        validateEnvelope({ status: 'success' })
      ).toThrow();
    });

    it('accepts partial status', () => {
      const envelope = validateEnvelope({
        task_id: 'task_003',
        status: 'partial',
        issues: ['timeout on step 3'],
      });

      expect(envelope.status).toBe('partial');
      expect(envelope.issues).toEqual(['timeout on step 3']);
    });
  });

  describe('JSON-RPC', () => {
    it('createRpcRequest', () => {
      const req = createRpcRequest('execute', { command: 'ls' }, 1);
      expect(req.jsonrpc).toBe('2.0');
      expect(req.method).toBe('execute');
      expect(req.params).toEqual({ command: 'ls' });
      expect(req.id).toBe(1);
    });

    it('createRpcResponse with result', () => {
      const resp = createRpcResponse(1, { ok: true });
      expect(resp.jsonrpc).toBe('2.0');
      expect(resp.id).toBe(1);
      expect(resp.result).toEqual({ ok: true });
      expect(resp.error).toBeUndefined();
    });

    it('createRpcResponse with error', () => {
      const resp = createRpcResponse(2, undefined, {
        code: -32600,
        message: 'Invalid request',
      });
      expect(resp.error!.code).toBe(-32600);
      expect(resp.result).toBeUndefined();
    });

    it('createRpcNotification', () => {
      const notif = createRpcNotification('heartbeat', { ts: 123 });
      expect(notif.jsonrpc).toBe('2.0');
      expect(notif.method).toBe('heartbeat');
      expect(notif.params).toEqual({ ts: 123 });
    });
  });

  describe('peer collaboration types', () => {
    it('creates peer request with defaults', () => {
      const brief = createBrief({ task_id: 't1', objective: 'test' });
      const req = createPeerRequest('agent-a', 'agent-b', brief);
      expect(req.request_id).toMatch(/^peer_/);
      expect(req.from_agent).toBe('agent-a');
      expect(req.to_agent).toBe('agent-b');
      expect(req.timeout_ms).toBe(30000);
    });

    it('creates peer response', () => {
      const resp = createPeerResponse('req-1', 'agent-b', 'completed', undefined, undefined);
      expect(resp.request_id).toBe('req-1');
      expect(resp.status).toBe('completed');
    });

    it('creates broadcast', () => {
      const bc = createBroadcast('agent-a', 'code_commit', { file: 'index.ts' });
      expect(bc.from_agent).toBe('agent-a');
      expect(bc.topic).toBe('code_commit');
    });

    it('creates capability advertisement', () => {
      const ad = createCapabilityAd('agent-a', ['code_python', 'test_writing'], 0.5);
      expect(ad.capabilities).toEqual(['code_python', 'test_writing']);
      expect(ad.load).toBe(0.5);
    });

    it('rejects invalid load', () => {
      expect(() => createCapabilityAd('a', [], 1.5)).toThrow();
    });
  });
});
