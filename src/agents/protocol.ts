import { z } from 'zod';

// ---------------------------------------------------------------------------
// Task Brief — sent from Brain to SubAgent
// ---------------------------------------------------------------------------

export const TaskBriefSchema = z.object({
  task_id: z.string(),
  objective: z.string(),
  done_criteria: z.string().default(''),
  constraints: z.object({
    token_budget: z.number().default(10000),
    timeout_seconds: z.number().default(300),
    permission_level: z.string().default('L0_READ_ONLY'),
    allowed_tools: z.array(z.string()).default([]),
    forbidden_paths: z.array(z.string()).default([]),
  }).default(() => ({ token_budget: 10000, timeout_seconds: 300, permission_level: 'L0_READ_ONLY', allowed_tools: [], forbidden_paths: [] })),
  context_refs: z.array(z.string()).default([]),
  hints: z.object({
    complexity: z.enum(['high', 'medium', 'low']).default('medium'),
    type: z.enum(['code', 'research', 'summary', 'review', 'general']).default('general'),
    needs_tool_calling: z.boolean().default(false),
    estimated_tokens: z.number().default(1000),
  }).default(() => ({ complexity: 'medium' as const, type: 'general' as const, needs_tool_calling: false, estimated_tokens: 1000 })),
});

export type TaskBrief = z.infer<typeof TaskBriefSchema>;

// ---------------------------------------------------------------------------
// Result Envelope — returned from SubAgent to Brain
// ---------------------------------------------------------------------------

export const ResultEnvelopeSchema = z.object({
  task_id: z.string(),
  status: z.enum(['success', 'failed', 'partial', 'cancelled']),
  output: z.array(z.string()).default([]),
  summary: z.string().default(''),
  cost: z.object({
    tokens: z.number().default(0),
    tool_calls: z.number().default(0),
    elapsed_time: z.number().default(0),
  }).default(() => ({ tokens: 0, tool_calls: 0, elapsed_time: 0 })),
  issues: z.array(z.string()).default([]),
});

export type ResultEnvelope = z.infer<typeof ResultEnvelopeSchema>;

// ---------------------------------------------------------------------------
// JSON-RPC messages for stdio communication
// ---------------------------------------------------------------------------

export const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.string(),
  params: z.unknown().optional(),
  id: z.union([z.string(), z.number()]),
});

export const JsonRpcResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  result: z.unknown().optional(),
  error: z.object({
    code: z.number(),
    message: z.string(),
    data: z.unknown().optional(),
  }).optional(),
  id: z.union([z.string(), z.number()]),
});

export const JsonRpcNotificationSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.string(),
  params: z.unknown().optional(),
});

export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;
export type JsonRpcResponse = z.infer<typeof JsonRpcResponseSchema>;
export type JsonRpcNotification = z.infer<typeof JsonRpcNotificationSchema>;

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

/** Create a validated TaskBrief from partial input */
export function createBrief(input: z.input<typeof TaskBriefSchema>): TaskBrief {
  return TaskBriefSchema.parse(input);
}

/** Validate and parse a ResultEnvelope */
export function validateEnvelope(input: unknown): ResultEnvelope {
  return ResultEnvelopeSchema.parse(input);
}

/** Create a JSON-RPC request message */
export function createRpcRequest(method: string, params: unknown, id: string | number): JsonRpcRequest {
  return { jsonrpc: '2.0', method, params, id };
}

/** Create a JSON-RPC response message */
export function createRpcResponse(id: string | number, result?: unknown, error?: { code: number; message: string; data?: unknown }): JsonRpcResponse {
  const resp: JsonRpcResponse = { jsonrpc: '2.0', id };
  if (error) resp.error = error;
  else resp.result = result;
  return resp;
}

/** Create a JSON-RPC notification (no id, no response expected) */
export function createRpcNotification(method: string, params?: unknown): JsonRpcNotification {
  return { jsonrpc: '2.0', method, params };
}

// ---------------------------------------------------------------------------
// Peer-to-Peer Collaboration Types
// ---------------------------------------------------------------------------

/** Capability advertisement — agents declare what they can do */
export const CapabilityAdvertisementSchema = z.object({
  agent_id: z.string(),
  capabilities: z.array(z.string()),
  load: z.number().min(0).max(1).default(0),
});
export type CapabilityAdvertisement = z.infer<typeof CapabilityAdvertisementSchema>;

/** Peer task request — agent asks another for help */
export const PeerTaskRequestSchema = z.object({
  request_id: z.string(),
  from_agent: z.string(),
  to_agent: z.string(),
  task_brief: TaskBriefSchema,
  timeout_ms: z.number().default(30000),
  priority: z.number().default(0),
});
export type PeerTaskRequest = z.infer<typeof PeerTaskRequestSchema>;

/** Peer task response */
export const PeerTaskResponseSchema = z.object({
  request_id: z.string(),
  from_agent: z.string(),
  status: z.enum(['accepted', 'rejected', 'completed', 'failed']),
  result: ResultEnvelopeSchema.optional(),
  reason: z.string().optional(),
});
export type PeerTaskResponse = z.infer<typeof PeerTaskResponseSchema>;

/** Broadcast message — sent to all agents on a topic */
export const PeerBroadcastSchema = z.object({
  from_agent: z.string(),
  topic: z.string(),
  payload: z.unknown(),
  ttl_seconds: z.number().optional(),
});
export type PeerBroadcast = z.infer<typeof PeerBroadcastSchema>;

// ---------------------------------------------------------------------------
// Peer Collaboration Factory Functions
// ---------------------------------------------------------------------------

/** Create a peer task request */
export function createPeerRequest(
  from: string,
  to: string,
  brief: TaskBrief,
  opts?: { timeout_ms?: number; priority?: number },
): PeerTaskRequest {
  return PeerTaskRequestSchema.parse({
    request_id: `peer_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    from_agent: from,
    to_agent: to,
    task_brief: brief,
    timeout_ms: opts?.timeout_ms ?? 30000,
    priority: opts?.priority ?? 0,
  });
}

/** Create a peer task response */
export function createPeerResponse(
  requestId: string,
  from: string,
  status: PeerTaskResponse['status'],
  result?: ResultEnvelope,
  reason?: string,
): PeerTaskResponse {
  return PeerTaskResponseSchema.parse({
    request_id: requestId,
    from_agent: from,
    status,
    result,
    reason,
  });
}

/** Create a broadcast message */
export function createBroadcast(
  from: string,
  topic: string,
  payload: unknown,
  ttl?: number,
): PeerBroadcast {
  return PeerBroadcastSchema.parse({
    from_agent: from,
    topic,
    payload,
    ttl_seconds: ttl,
  });
}

/** Create a capability advertisement */
export function createCapabilityAd(
  agentId: string,
  capabilities: string[],
  load = 0,
): CapabilityAdvertisement {
  return CapabilityAdvertisementSchema.parse({
    agent_id: agentId,
    capabilities,
    load,
  });
}
