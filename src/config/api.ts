/**
 * Config Hot Reload API — Fastify route for runtime config updates.
 *
 * POST /api/config { key, value }
 * Only hot-reloadable keys: system.*, token_budget.*, evolution.*, rate_limits.*
 * Rejects changes to brain.*, security.* (need restart).
 */

import type { FastifyInstance } from 'fastify';
import { updateConfig, getConfig } from './index.js';
import { log as logEvent } from '../store/events.js';
import { logAudit } from '../security/audit.js';
import { z } from 'zod';
import pino from 'pino';

const logger = pino({ name: 'mozi:config:api' });

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

const ConfigUpdateSchema = z.object({
  key: z.string().min(1),
  value: z.unknown(),
});

// ---------------------------------------------------------------------------
// Fastify route registration
// ---------------------------------------------------------------------------

/**
 * Register config hot-reload API routes on a Fastify instance.
 */
export function registerConfigRoutes(app: FastifyInstance): void {
  app.post('/api/config', async (request, reply) => {
    try {
      const body = ConfigUpdateSchema.parse(request.body);

      const before = (() => {
        try {
          const cfg = getConfig() as Record<string, unknown>;
          const parts = body.key.split('.');
          let cur: unknown = cfg;
          for (const p of parts) {
            cur = (cur as Record<string, unknown>)?.[p];
          }
          return cur;
        } catch {
          return undefined;
        }
      })();

      updateConfig(body.key, body.value);

      logEvent('config_updated', 'config', body.key, { value: body.value });
      logAudit({
        action: 'config.update',
        resource_type: 'config',
        resource_id: body.key,
        details: { before, after: body.value },
      });
      logger.info({ key: body.key }, 'Config updated via API');

      return reply.send({
        success: true,
        key: body.key,
        value: body.value,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ error: message }, 'Config update rejected');

      return reply.status(400).send({
        success: false,
        error: message,
      });
    }
  });

  app.get('/api/config', async (_request, reply) => {
    const config = getConfig();
    return reply.send({ success: true, config });
  });
}

// ---------------------------------------------------------------------------
// Telegram /config command handler
// ---------------------------------------------------------------------------

/**
 * Handle /config set <key> <value> command from Telegram or WebSocket.
 *
 * @param args - The command arguments (e.g. "set system.max_parallel_agents 10")
 * @returns Response message string
 */
export function handleConfigCommand(args: string): string {
  if (!args || !args.trim()) {
    // Show current config summary
    const config = getConfig();
    const lines = [
      'Current configuration:',
      `  system.max_parallel_agents = ${config.system.max_parallel_agents}`,
      `  system.watchdog_interval_seconds = ${config.system.watchdog_interval_seconds}`,
      `  token_budget.watermark_soft = ${config.token_budget.watermark_soft}`,
      `  token_budget.watermark_hard = ${config.token_budget.watermark_hard}`,
      `  evolution.promote_min_score = ${config.evolution.promote_min_score}`,
      `  brain.model = ${config.brain.model} (restart required)`,
      '',
      'Usage: /config set <key> <value>',
    ];
    return lines.join('\n');
  }

  const parts = args.trim().split(/\s+/);
  if (parts[0] !== 'set' || parts.length < 3) {
    return 'Usage: /config set <key> <value>';
  }

  const key = parts[1];
  const rawValue = parts.slice(2).join(' ');

  // Parse value: try number, then boolean, then string
  let value: unknown = rawValue;
  const num = Number(rawValue);
  if (!isNaN(num) && rawValue.trim() !== '') {
    value = num;
  } else if (rawValue === 'true') {
    value = true;
  } else if (rawValue === 'false') {
    value = false;
  }

  try {
    updateConfig(key, value);
    logEvent('config_updated', 'config', key, { value, source: 'command' });
    return `Config updated: ${key} = ${JSON.stringify(value)}`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Config update failed: ${message}`;
  }
}
