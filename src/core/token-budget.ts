/**
 * Legacy workspace token telemetry. This module never drives conversation
 * reduction; durable session reduction lives in conversation-context-reducer.
 *
 * Zones: system, memory, tasks, dialogue, workspace
 * Watermarks: 70% soft, 85% hard, 95% rotate (session handoff)
 */

import { getConfig } from '../config/index.js';
import pino from 'pino';

const logger = pino({ name: 'mozi:token-budget' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Zone = 'system' | 'memory' | 'tasks' | 'dialogue' | 'workspace';

export type WatermarkLevel = 'normal' | 'soft' | 'hard' | 'rotate';

export interface ZoneUsage {
  system: number;
  memory: number;
  tasks: number;
  dialogue: number;
  workspace: number;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let windowSize = 200000; // Default context window size in tokens
const usage: ZoneUsage = {
  system: 0,
  memory: 0,
  tasks: 0,
  dialogue: 0,
  workspace: 0,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Set the total context window size in tokens */
export function setWindowSize(size: number): void {
  windowSize = size;
  logger.debug({ window_size: size }, 'Window size set');
}

/** Get the total context window size */
export function getWindowSize(): number {
  return windowSize;
}

/** Update zone usage values */
export function update(zones: Partial<ZoneUsage>): void {
  if (zones.system !== undefined) usage.system = zones.system;
  if (zones.memory !== undefined) usage.memory = zones.memory;
  if (zones.tasks !== undefined) usage.tasks = zones.tasks;
  if (zones.dialogue !== undefined) usage.dialogue = zones.dialogue;
  if (zones.workspace !== undefined) usage.workspace = zones.workspace;

  logger.debug({ usage, total: getTotalUsage(), pct: getUsagePercent() }, 'Usage updated');
}

/** Get current usage for a specific zone */
export function getZoneUsage(zone: Zone): number {
  return usage[zone];
}

/** Get all zone usage */
export function getAllUsage(): ZoneUsage {
  return { ...usage };
}

/** Get total token usage across all zones */
export function getTotalUsage(): number {
  return usage.system + usage.memory + usage.tasks + usage.dialogue + usage.workspace;
}

/** Get usage as a percentage of window size */
export function getUsagePercent(): number {
  return getTotalUsage() / windowSize;
}

/**
 * Get the current watermark level based on usage percentage.
 */
export function getWatermark(): WatermarkLevel {
  const config = getConfig();
  const pct = getUsagePercent();

  if (pct >= config.token_budget.watermark_rotate) return 'rotate';
  if (pct >= config.token_budget.watermark_hard) return 'hard';
  if (pct >= config.token_budget.watermark_soft) return 'soft';
  return 'normal';
}

/** Get remaining tokens in the budget */
export function getRemaining(): number {
  return Math.max(0, windowSize - getTotalUsage());
}

/** Reset all usage to zero (for testing or session reset) */
export function reset(): void {
  usage.system = 0;
  usage.memory = 0;
  usage.tasks = 0;
  usage.dialogue = 0;
  usage.workspace = 0;
}
