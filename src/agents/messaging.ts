import { z } from 'zod';
import { getDb } from '../store/db.js';
import { notify, listActive } from './process-manager.js';
import pino from 'pino';

const logger = pino({ name: 'mozi:agent-messaging' });

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const AgentMessageSchema = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  type: z.enum(['task_delegate', 'help_request', 'result_share', 'status_update', 'progress_report', 'peer_request', 'peer_response', 'capability_ad', 'broadcast']),
  payload: z.unknown(),
  reply_to: z.string().optional(),
  timestamp: z.number(),
});

export type AgentMessage = z.infer<typeof AgentMessageSchema>;

const CHANNEL = 'agent_msg';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Create a properly structured AgentMessage with unique id and timestamp */
export function createMessage(
  from: string,
  to: string,
  type: AgentMessage['type'],
  payload: unknown,
  replyTo?: string,
): AgentMessage {
  return {
    id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    from,
    to,
    type,
    payload,
    reply_to: replyTo,
    timestamp: Date.now(),
  };
}

/** Validate and enqueue a message into the message_queue table */
export function send(msg: AgentMessage, tenantId = 'default'): void {
  const validated = AgentMessageSchema.parse(msg);
  const db = getDb();

  db.prepare(`
    INSERT INTO message_queue (tenant_id, channel, sender, receiver, payload, priority, status, created_at)
    VALUES (?, ?, ?, ?, ?, 0, 'pending', datetime('now'))
  `).run(tenantId, CHANNEL, validated.from, validated.to, JSON.stringify(validated));

  logger.info({ msg_id: validated.id, from: validated.from, to: validated.to, type: validated.type }, 'Agent message sent');
}

/** Dequeue all pending messages for a specific agent */
export function receive(agentId: string, tenantId = 'default'): AgentMessage[] {
  const db = getDb();

  const rows = db.prepare(`
    SELECT id, payload FROM message_queue
    WHERE tenant_id = ? AND channel = ? AND receiver = ? AND status = 'pending'
    ORDER BY priority DESC, created_at ASC
  `).all(tenantId, CHANNEL, agentId) as { id: number; payload: string }[];

  if (rows.length === 0) return [];

  // Mark all fetched rows as processed in one statement
  const ids = rows.map((r) => r.id);
  db.prepare(
    `UPDATE message_queue SET status = 'processed', processed_at = datetime('now') WHERE id IN (${ids.map(() => '?').join(',')})`,
  ).run(...ids);

  const messages: AgentMessage[] = [];
  for (const row of rows) {
    try {
      messages.push(AgentMessageSchema.parse(JSON.parse(row.payload)));
    } catch (err) {
      logger.warn({ row_id: row.id, error: err }, 'Invalid agent message payload, skipping');
    }
  }

  logger.info({ agentId, count: messages.length }, 'Agent messages received');
  return messages;
}

/** Broadcast a message to all active agent processes */
export function broadcast(
  from: string,
  type: AgentMessage['type'],
  payload: unknown,
  tenantId = 'default',
): void {
  const active = listActive();
  if (active.length === 0) {
    logger.debug({ from, type }, 'Broadcast: no active agents');
    return;
  }

  for (const proc of active) {
    const msg = createMessage(from, proc.id, type, payload);
    send(msg, tenantId);
  }

  logger.info({ from, type, recipientCount: active.length }, 'Broadcast sent to active agents');
}

/** Receive broadcast messages addressed to 'broadcast' receiver */
export function receiveBroadcasts(agentId: string, tenantId = 'default'): AgentMessage[] {
  // Broadcasts are sent individually to each agent via broadcast(),
  // so this is an alias for receive() — included for API clarity.
  // If callers want broadcasts specifically, they get them from the same queue.
  return receive(agentId, tenantId);
}

/** Forward a message to a running subprocess via JSON-RPC notification */
export function forwardToProcess(processId: string, message: AgentMessage): void {
  const validated = AgentMessageSchema.parse(message);
  notify(processId, 'agent_message', validated);
  logger.debug({ processId, msg_id: validated.id }, 'Message forwarded to process');
}
