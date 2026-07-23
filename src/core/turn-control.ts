/**
 * Turn Control State Machine
 * -------------------------
 * Internal state machine for one user turn lifecycle.
 * This is control-plane state (not UI-only state).
 */

export type TurnState =
  | 'QUEUED'
  | 'PLANNING'
  | 'EXECUTING'
  | 'RECOVERING'
  | 'WAITING_INPUT'
  | 'RESPONDING'
  | 'DONE'
  | 'CANCELLED'
  | 'FAILED';

export interface TurnStateSnapshot {
  chatId: string;
  userId: string;
  state: TurnState;
  updatedAt: number;
  detail?: string;
}

interface TurnControl {
  readonly turnId: string;
  readonly chatId: string;
  readonly userId: string;
  state(): TurnState;
  transition(to: TurnState, detail?: string): TurnStateSnapshot;
  snapshot(): TurnStateSnapshot;
}

const VALID_TURN_TRANSITIONS: Record<TurnState, TurnState[]> = {
  QUEUED: ['PLANNING', 'CANCELLED', 'FAILED'],
  PLANNING: ['EXECUTING', 'CANCELLED', 'FAILED'],
  EXECUTING: ['RECOVERING', 'WAITING_INPUT', 'RESPONDING', 'CANCELLED', 'FAILED'],
  RECOVERING: ['EXECUTING', 'WAITING_INPUT', 'RESPONDING', 'CANCELLED', 'FAILED'],
  WAITING_INPUT: ['RESPONDING', 'DONE', 'CANCELLED'],
  RESPONDING: ['DONE', 'CANCELLED', 'FAILED'],
  DONE: [],
  CANCELLED: [],
  FAILED: [],
};

export function createTurnControl(chatId: string, userId: string): TurnControl {
  const turnId = `turn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  let current: TurnState = 'QUEUED';
  let updatedAt = Date.now();
  let detail: string | undefined;

  const snapshot = (): TurnStateSnapshot => ({
    chatId,
    userId,
    state: current,
    updatedAt,
    detail,
  });

  const transition = (to: TurnState, nextDetail?: string): TurnStateSnapshot => {
    if (to === current) {
      if (typeof nextDetail === 'string' && nextDetail.length > 0) {
        detail = nextDetail;
        updatedAt = Date.now();
      }
      return snapshot();
    }

    const allowed = VALID_TURN_TRANSITIONS[current];
    if (!allowed.includes(to)) {
      throw new Error(`Invalid turn-state transition: ${current} -> ${to}`);
    }

    current = to;
    updatedAt = Date.now();
    detail = nextDetail;
    return snapshot();
  };

  return {
    turnId,
    chatId,
    userId,
    state: () => current,
    transition,
    snapshot,
  };
}
