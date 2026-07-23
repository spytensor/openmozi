type SessionState = 'IDLE' | 'WORKING' | 'RESPONDING';

interface Session {
  id: string;
  tenantId: string;
  state: SessionState;
  createdAt: Date;
  updatedAt: Date;
  transition(to: SessionState): void;
}

// Valid state transitions
const VALID_TRANSITIONS: Record<SessionState, SessionState[]> = {
  IDLE: ['WORKING'],
  WORKING: ['RESPONDING'],
  RESPONDING: ['IDLE', 'WORKING'],
};

/** Create a new session with IDLE state */
export function createSession(tenantId = 'default'): Session {
  const id = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const session: Session = {
    id,
    tenantId,
    state: 'IDLE',
    createdAt: new Date(),
    updatedAt: new Date(),

    transition(to: SessionState): void {
      const allowed = VALID_TRANSITIONS[session.state];
      if (!allowed.includes(to)) {
        throw new Error(
          `Invalid state transition: ${session.state} → ${to}. Allowed: ${allowed.join(', ')}`
        );
      }
      session.state = to;
      session.updatedAt = new Date();
    },
  };

  return session;
}
