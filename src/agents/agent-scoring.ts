/**
 * Agent Performance Scoring + Lifecycle Evaluation.
 *
 * score = w1*success_rate + w2*efficiency_score + w3*reliability_score
 *
 * Where:
 * - success_rate     = completed_tasks / total_tasks
 * - efficiency_score = 1 - (avg_token_cost / budget_allocated)
 * - reliability_score = 1 - (avg_retries / max_retries)
 */

import { getDb } from '../store/db.js';
import { log as logEvent } from '../store/events.js';
import * as registry from './registry.js';
import { getConfig } from '../config/index.js';
import { createApprovalRequest, getPendingRequests } from '../security/gates.js';
import { z } from 'zod';
import pino from 'pino';

const logger = pino({ name: 'mozi:agent-scoring' });

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

/** Weights for the score formula */
export const WeightsSchema = z.object({
  w1: z.number().min(0).max(1).default(0.5),
  w2: z.number().min(0).max(1).default(0.3),
  w3: z.number().min(0).max(1).default(0.2),
});

export type Weights = z.infer<typeof WeightsSchema>;

/** Breakdown of a score calculation */
export interface ScoreBreakdown {
  agentId: string;
  successRate: number;
  efficiencyScore: number;
  reliabilityScore: number;
  evolutionScore: number;
  totalTasks: number;
  completedTasks: number;
  avgTokenCost: number;
  avgRetries: number;
  weights: Weights;
}

export type EvolutionLifecycleAction =
  | 'none'
  | 'promote_proposed'
  | 'promoted'
  | 'demoted'
  | 'blacklisted'
  | 'archived';

export interface EvolutionLifecycleDecision {
  action: EvolutionLifecycleAction;
  applied: boolean;
  requiresApproval: boolean;
  reason: string;
  agentId: string;
  tenantId: string;
  previousType: 'preset' | 'dynamic' | null;
  nextType: 'preset' | 'dynamic' | null;
  previousStatus: 'active' | 'inactive' | 'archived' | null;
  nextStatus: 'active' | 'inactive' | 'archived' | null;
  evolutionScore: number;
  totalTasks: number;
  spawnCount: number;
  thresholds: {
    promoteMinSpawns: number;
    promoteMinScore: number;
    demoteMinTasks: number;
    demoteScoreThreshold: number;
    blacklistMinSpawns: number;
    blacklistScoreThreshold: number;
    archiveInactiveDays: number;
  };
}

export interface ScoreRefreshResult {
  breakdown: ScoreBreakdown;
  decision: EvolutionLifecycleDecision;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface AttemptRow {
  task_id: string;
  attempt_number: number;
  result_status: string | null;
  result_payload: string | null;
}

/**
 * Extract token cost from a task attempt's result_payload.
 * Looks for a `token_cost` or `tokens_used` field in the JSON payload.
 */
function extractTokenCost(row: AttemptRow): number {
  if (!row.result_payload) return 0;
  try {
    const payload = JSON.parse(row.result_payload) as Record<string, unknown>;
    const cost = payload.token_cost ?? payload.tokens_used ?? 0;
    return typeof cost === 'number' ? cost : 0;
  } catch {
    return 0;
  }
}

const BLACKLIST_MIN_SPAWNS = 3;
const BLACKLIST_SCORE_THRESHOLD = 0.3;
const DAY_MS = 24 * 60 * 60 * 1000;

function asConfigRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return { ...(value as Record<string, unknown>) };
}

function parseUtcDateToMs(value: string): number | null {
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  const hasTimezone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(normalized);
  const parsed = Date.parse(hasTimezone ? normalized : `${normalized}Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildDecision(
  partial: Omit<EvolutionLifecycleDecision, 'thresholds'>,
  thresholds: EvolutionLifecycleDecision['thresholds'],
): EvolutionLifecycleDecision {
  return { ...partial, thresholds };
}

function recordLifecycleAction(decision: EvolutionLifecycleDecision): void {
  if (decision.action === 'none') return;
  logEvent('agent_evolution_action', 'agent', decision.agentId, decision, decision.tenantId);
  logger.info({
    agent_id: decision.agentId,
    action: decision.action,
    requires_approval: decision.requiresApproval,
    applied: decision.applied,
    reason: decision.reason,
  }, 'Agent evolution lifecycle action');
}

function hasPendingPromotionRequest(agentId: string, tenantId: string): boolean {
  const pending = getPendingRequests(tenantId);
  return pending.some((req) => req.action === 'agent_promote' && req.context?.agent_id === agentId);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Calculate the performance score for an agent based on its task_attempts data.
 *
 * Queries task_attempts for the given agent, computes success_rate,
 * efficiency_score, and reliability_score, then writes the updated scores
 * back to agent_registry and logs an event.
 *
 * @param agentId  - The agent ID to score
 * @param tenantId - Tenant (defaults to 'default')
 * @param weights  - Optional weight overrides {w1, w2, w3}
 * @returns The full score breakdown
 */
export function calculateScore(
  agentId: string,
  tenantId = 'default',
  weights?: Partial<Weights>,
): ScoreBreakdown {
  const w = WeightsSchema.parse(weights ?? {});
  const db = getDb();

  // Fetch all attempts for this agent
  const attempts = db.prepare(`
    SELECT task_id, attempt_number, result_status, result_payload
    FROM task_attempts
    WHERE agent_id = ? AND tenant_id = ?
  `).all(agentId, tenantId) as AttemptRow[];

  // Group by task_id to determine per-task outcomes
  const taskMap = new Map<string, AttemptRow[]>();
  for (const row of attempts) {
    const list = taskMap.get(row.task_id) ?? [];
    list.push(row);
    taskMap.set(row.task_id, list);
  }

  const totalTasks = taskMap.size;

  // A task is "completed" if any attempt has result_status === 'completed'
  let completedTasks = 0;
  for (const [, taskAttempts] of taskMap) {
    if (taskAttempts.some((a) => a.result_status === 'completed')) {
      completedTasks++;
    }
  }

  const successRate = totalTasks > 0 ? completedTasks / totalTasks : 0;

  // Avg token cost across all attempts
  let totalTokenCost = 0;
  for (const row of attempts) {
    totalTokenCost += extractTokenCost(row);
  }
  const avgTokenCost = attempts.length > 0 ? totalTokenCost / attempts.length : 0;

  // Budget allocated: check agent config, default 100000
  const agent = registry.get(agentId, tenantId);
  const budgetAllocated =
    (agent?.config as Record<string, unknown> | undefined)?.budget_allocated as number | undefined
    ?? 100000;

  const efficiencyScore = Math.max(0, 1 - avgTokenCost / budgetAllocated);

  // Avg retries per task: (total attempts - total tasks) / total tasks
  // max_retries defaults to 3
  const maxRetries = 3;
  const avgRetries = totalTasks > 0 ? Math.max(0, (attempts.length - totalTasks) / totalTasks) : 0;
  const reliabilityScore = Math.max(0, 1 - avgRetries / maxRetries);

  // Composite score
  const evolutionScore = w.w1 * successRate + w.w2 * efficiencyScore + w.w3 * reliabilityScore;

  // Update agent_registry
  registry.update(
    agentId,
    {
      success_rate: successRate,
      avg_token_cost: avgTokenCost,
      evolution_score: evolutionScore,
    },
    tenantId,
  );

  // Log event
  const breakdown: ScoreBreakdown = {
    agentId,
    successRate,
    efficiencyScore,
    reliabilityScore,
    evolutionScore,
    totalTasks,
    completedTasks,
    avgTokenCost,
    avgRetries,
    weights: w,
  };

  logEvent('evolution_score_calculated', 'agent', agentId, breakdown, tenantId);
  logger.info({ agent_id: agentId, evolution_score: evolutionScore }, 'Agent score calculated');

  return breakdown;
}

/**
 * Evaluate lifecycle transitions from the latest score and runtime policy.
 *
 * Priority order:
 * 1) archive stale inactive agents
 * 2) blacklist consistently low-performing dynamic agents
 * 3) demote low-performing preset agents
 * 4) promote/propose high-performing dynamic agents
 */
export function evaluateEvolutionLifecycle(
  agentId: string,
  breakdown: ScoreBreakdown,
  tenantId = 'default',
  snapshot?: registry.AgentRecord | null,
): EvolutionLifecycleDecision {
  const cfg = getConfig();
  const evolution = cfg.evolution;
  const thresholds: EvolutionLifecycleDecision['thresholds'] = {
    promoteMinSpawns: evolution.promote_min_spawns,
    promoteMinScore: evolution.promote_min_score,
    demoteMinTasks: evolution.demote_min_tasks,
    demoteScoreThreshold: evolution.demote_score_threshold,
    blacklistMinSpawns: BLACKLIST_MIN_SPAWNS,
    blacklistScoreThreshold: BLACKLIST_SCORE_THRESHOLD,
    archiveInactiveDays: evolution.archive_inactive_days,
  };

  const agent = snapshot ?? registry.get(agentId, tenantId);
  if (!agent) {
    return buildDecision({
      action: 'none',
      applied: false,
      requiresApproval: false,
      reason: 'agent_not_found',
      agentId,
      tenantId,
      previousType: null,
      nextType: null,
      previousStatus: null,
      nextStatus: null,
      evolutionScore: breakdown.evolutionScore,
      totalTasks: breakdown.totalTasks,
      spawnCount: 0,
    }, thresholds);
  }

  const previousType = agent.type;
  const previousStatus = agent.status;
  const agentConfig = asConfigRecord(agent.config);
  const evolutionMeta = asConfigRecord(agentConfig.evolution);

  if (agent.status === 'inactive' && thresholds.archiveInactiveDays > 0) {
    const updatedMs = parseUtcDateToMs(agent.updated_at);
    if (updatedMs !== null) {
      const ageDays = (Date.now() - updatedMs) / DAY_MS;
      if (ageDays >= thresholds.archiveInactiveDays) {
        registry.update(agentId, { status: 'archived' }, tenantId);
        const decision = buildDecision({
          action: 'archived',
          applied: true,
          requiresApproval: false,
          reason: `inactive_for_${Math.floor(ageDays)}d`,
          agentId,
          tenantId,
          previousType,
          nextType: previousType,
          previousStatus,
          nextStatus: 'archived',
          evolutionScore: breakdown.evolutionScore,
          totalTasks: breakdown.totalTasks,
          spawnCount: agent.spawn_count,
        }, thresholds);
        recordLifecycleAction(decision);
        return decision;
      }
    }
  }

  if (
    agent.type === 'dynamic'
    && agent.status === 'active'
    && agent.spawn_count >= thresholds.blacklistMinSpawns
    && breakdown.evolutionScore < thresholds.blacklistScoreThreshold
  ) {
    registry.update(agentId, {
      status: 'inactive',
      config: {
        ...agentConfig,
        evolution: {
          ...evolutionMeta,
          blacklisted: true,
          blacklisted_at: new Date().toISOString(),
          blacklisted_reason: 'score_below_threshold',
          blacklisted_score: breakdown.evolutionScore,
        },
      },
    }, tenantId);
    const decision = buildDecision({
      action: 'blacklisted',
      applied: true,
      requiresApproval: false,
      reason: 'dynamic_agent_underperformed',
      agentId,
      tenantId,
      previousType,
      nextType: previousType,
      previousStatus,
      nextStatus: 'inactive',
      evolutionScore: breakdown.evolutionScore,
      totalTasks: breakdown.totalTasks,
      spawnCount: agent.spawn_count,
    }, thresholds);
    recordLifecycleAction(decision);
    return decision;
  }

  if (
    agent.type === 'preset'
    && agent.status === 'active'
    && breakdown.totalTasks >= thresholds.demoteMinTasks
    && breakdown.evolutionScore < thresholds.demoteScoreThreshold
  ) {
    registry.update(agentId, {
      type: 'dynamic',
      config: {
        ...agentConfig,
        evolution: {
          ...evolutionMeta,
          demoted_from_preset: true,
          demoted_at: new Date().toISOString(),
          demoted_score: breakdown.evolutionScore,
        },
      },
    }, tenantId);
    const decision = buildDecision({
      action: 'demoted',
      applied: true,
      requiresApproval: false,
      reason: 'preset_agent_underperformed',
      agentId,
      tenantId,
      previousType,
      nextType: 'dynamic',
      previousStatus,
      nextStatus: previousStatus,
      evolutionScore: breakdown.evolutionScore,
      totalTasks: breakdown.totalTasks,
      spawnCount: agent.spawn_count,
    }, thresholds);
    recordLifecycleAction(decision);
    return decision;
  }

  if (
    agent.type === 'dynamic'
    && agent.status === 'active'
    && agent.spawn_count >= thresholds.promoteMinSpawns
    && breakdown.evolutionScore >= thresholds.promoteMinScore
  ) {
    const hardGates = cfg.security.hard_gates ?? [];
    const requiresApproval = hardGates.includes('agent_promote');
    if (requiresApproval) {
      if (hasPendingPromotionRequest(agentId, tenantId)) {
        return buildDecision({
          action: 'none',
          applied: false,
          requiresApproval: true,
          reason: 'promotion_pending_approval',
          agentId,
          tenantId,
          previousType,
          nextType: previousType,
          previousStatus,
          nextStatus: previousStatus,
          evolutionScore: breakdown.evolutionScore,
          totalTasks: breakdown.totalTasks,
          spawnCount: agent.spawn_count,
        }, thresholds);
      }
      createApprovalRequest(
        'agent_promote',
        `Promote agent ${agentId} to preset`,
        {
          agent_id: agentId,
          tenant_id: tenantId,
          evolution_score: breakdown.evolutionScore,
          spawn_count: agent.spawn_count,
          total_tasks: breakdown.totalTasks,
        },
        'agent-evolution',
        tenantId,
      );
      const decision = buildDecision({
        action: 'promote_proposed',
        applied: false,
        requiresApproval: true,
        reason: 'promotion_requires_hard_gate_approval',
        agentId,
        tenantId,
        previousType,
        nextType: 'preset',
        previousStatus,
        nextStatus: previousStatus,
        evolutionScore: breakdown.evolutionScore,
        totalTasks: breakdown.totalTasks,
        spawnCount: agent.spawn_count,
      }, thresholds);
      recordLifecycleAction(decision);
      return decision;
    }

    registry.update(agentId, {
      type: 'preset',
      config: {
        ...agentConfig,
        evolution: {
          ...evolutionMeta,
          promoted_to_preset: true,
          promoted_at: new Date().toISOString(),
          promoted_score: breakdown.evolutionScore,
        },
      },
    }, tenantId);
    const decision = buildDecision({
      action: 'promoted',
      applied: true,
      requiresApproval: false,
      reason: 'dynamic_agent_met_promotion_threshold',
      agentId,
      tenantId,
      previousType,
      nextType: 'preset',
      previousStatus,
      nextStatus: previousStatus,
      evolutionScore: breakdown.evolutionScore,
      totalTasks: breakdown.totalTasks,
      spawnCount: agent.spawn_count,
    }, thresholds);
    recordLifecycleAction(decision);
    return decision;
  }

  return buildDecision({
    action: 'none',
    applied: false,
    requiresApproval: false,
    reason: 'no_lifecycle_transition',
    agentId,
    tenantId,
    previousType,
    nextType: previousType,
    previousStatus,
    nextStatus: previousStatus,
    evolutionScore: breakdown.evolutionScore,
    totalTasks: breakdown.totalTasks,
    spawnCount: agent.spawn_count,
  }, thresholds);
}

/**
 * Recompute score and evaluate lifecycle transitions in one deterministic step.
 */
export function refreshScoreAndMaybeEvolve(
  agentId: string,
  tenantId = 'default',
  weights?: Partial<Weights>,
): ScoreRefreshResult {
  const snapshot = registry.get(agentId, tenantId);
  const breakdown = calculateScore(agentId, tenantId, weights);
  const decision = evaluateEvolutionLifecycle(agentId, breakdown, tenantId, snapshot);
  return { breakdown, decision };
}

/**
 * Get the current evolution_score for an agent from the registry.
 *
 * @param agentId  - The agent ID
 * @param tenantId - Tenant (defaults to 'default')
 * @returns The evolution score, or null if agent not found
 */
export function getScore(agentId: string, tenantId = 'default'): number | null {
  const agent = registry.get(agentId, tenantId);
  if (!agent) return null;
  return agent.evolution_score;
}

/**
 * Return the top N agents ordered by evolution_score descending.
 *
 * @param n        - Number of agents to return
 * @param tenantId - Tenant (defaults to 'default')
 * @returns Array of AgentRecords sorted by evolution_score desc
 */
export function getTopAgents(n: number, tenantId = 'default'): registry.AgentRecord[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM agent_registry
    WHERE tenant_id = ?
    ORDER BY evolution_score DESC
    LIMIT ?
  `).all(tenantId, n) as Record<string, unknown>[];

  return rows.map((row) => ({
    id: row.id as string,
    tenant_id: row.tenant_id as string,
    name: row.name as string,
    type: row.type as 'preset' | 'dynamic',
    system_prompt: row.system_prompt as string | undefined,
    tools_allowed: row.tools_allowed ? JSON.parse(row.tools_allowed as string) : [],
    permission_level: row.permission_level as string,
    config: row.config ? JSON.parse(row.config as string) : undefined,
    status: row.status as 'active' | 'inactive' | 'archived',
    spawn_count: row.spawn_count as number,
    success_rate: row.success_rate as number,
    avg_token_cost: row.avg_token_cost as number,
    evolution_score: row.evolution_score as number,
    created_by: row.created_by as string,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  }));
}

/**
 * Return agents whose evolution_score is below the given threshold.
 *
 * @param threshold - Score threshold
 * @param tenantId  - Tenant (defaults to 'default')
 * @returns Array of AgentRecords with evolution_score < threshold
 */
export function getUnderperformers(threshold: number, tenantId = 'default'): registry.AgentRecord[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM agent_registry
    WHERE tenant_id = ? AND evolution_score < ?
    ORDER BY evolution_score ASC
  `).all(tenantId, threshold) as Record<string, unknown>[];

  return rows.map((row) => ({
    id: row.id as string,
    tenant_id: row.tenant_id as string,
    name: row.name as string,
    type: row.type as 'preset' | 'dynamic',
    system_prompt: row.system_prompt as string | undefined,
    tools_allowed: row.tools_allowed ? JSON.parse(row.tools_allowed as string) : [],
    permission_level: row.permission_level as string,
    config: row.config ? JSON.parse(row.config as string) : undefined,
    status: row.status as 'active' | 'inactive' | 'archived',
    spawn_count: row.spawn_count as number,
    success_rate: row.success_rate as number,
    avg_token_cost: row.avg_token_cost as number,
    evolution_score: row.evolution_score as number,
    created_by: row.created_by as string,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  }));
}
