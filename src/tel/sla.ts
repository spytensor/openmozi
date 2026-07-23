import { z } from 'zod';
import pino from 'pino';

const logger = pino({ name: 'mozi:tel:sla' });

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const ToolSlaSchema = z.object({
  timeout: z.number(),                // Hard timeout in seconds
  soft_timeout: z.number().optional(), // Soft timeout (warn) in seconds
  retries: z.number().default(0),
  retry_strategy: z.enum(['immediate', 'linear_backoff', 'exponential_backoff']).default('immediate'),
  fallback: z.string().optional(),     // Fallback action name
  sandbox: z.enum(['none', 'restricted', 'docker']).default('none'),
});

export type ToolSla = z.infer<typeof ToolSlaSchema>;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const registry = new Map<string, ToolSla>();

/** Register SLA for a tool */
export function register(tool: string, sla: z.input<typeof ToolSlaSchema>): void {
  const validated = ToolSlaSchema.parse(sla);
  registry.set(tool, validated);
  logger.debug({ tool, timeout: validated.timeout, retries: validated.retries }, 'Tool SLA registered');
}

/** Get SLA for a tool. Returns default SLA if not registered. */
export function get(tool: string): ToolSla {
  return registry.get(tool) ?? DEFAULT_SLA;
}

/** Check if a tool has a registered SLA */
export function has(tool: string): boolean {
  return registry.has(tool);
}

/** List all registered tool SLAs */
export function listAll(): Map<string, ToolSla> {
  return new Map(registry);
}

/** Remove SLA for a tool */
export function remove(tool: string): boolean {
  return registry.delete(tool);
}

/** Reset all SLA registrations */
export function reset(): void {
  registry.clear();
}

// ---------------------------------------------------------------------------
// Default SLA
// ---------------------------------------------------------------------------

const DEFAULT_SLA: ToolSla = {
  timeout: 60,
  retries: 0,
  retry_strategy: 'immediate',
  sandbox: 'none',
};

/**
 * Calculate delay between retries based on strategy.
 * @param attempt - zero-indexed retry attempt number
 * @param strategy - retry strategy
 * @returns delay in milliseconds
 */
export function getRetryDelay(attempt: number, strategy: ToolSla['retry_strategy']): number {
  switch (strategy) {
    case 'immediate':
      return 0;
    case 'linear_backoff':
      return (attempt + 1) * 1000;
    case 'exponential_backoff':
      return Math.min(2 ** attempt * 1000, 30_000);
    default:
      return 0;
  }
}
