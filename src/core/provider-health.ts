type HealthStatus = 'healthy' | 'degraded' | 'down';

interface ProviderHealthState {
  status: HealthStatus;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  lastSuccess: Date | null;
  lastFailure: Date | null;
  latencyMs: number[];
}

const providers = new Map<string, ProviderHealthState>();

const DEGRADED_THRESHOLD = 2;
const DOWN_THRESHOLD = 3;
const RECOVERY_THRESHOLD = 2;
const MAX_LATENCY_SAMPLES = 20;

function getOrCreate(provider: string): ProviderHealthState {
  let state = providers.get(provider);
  if (!state) {
    state = {
      status: 'healthy',
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      lastSuccess: null,
      lastFailure: null,
      latencyMs: [],
    };
    providers.set(provider, state);
  }
  return state;
}

/** Report a successful API call */
export function reportSuccess(provider: string, latencyMs?: number): void {
  const state = getOrCreate(provider);
  state.consecutiveSuccesses++;
  state.consecutiveFailures = 0;
  state.lastSuccess = new Date();

  if (latencyMs !== undefined) {
    state.latencyMs.push(latencyMs);
    if (state.latencyMs.length > MAX_LATENCY_SAMPLES) {
      state.latencyMs.shift();
    }
  }

  // Recovery logic
  if (state.status === 'down' && state.consecutiveSuccesses >= RECOVERY_THRESHOLD) {
    state.status = 'degraded';
  } else if (state.status === 'degraded' && state.consecutiveSuccesses >= RECOVERY_THRESHOLD) {
    state.status = 'healthy';
  }
}

/** Report a failed API call */
export function reportFailure(provider: string): void {
  const state = getOrCreate(provider);
  state.consecutiveFailures++;
  state.consecutiveSuccesses = 0;
  state.lastFailure = new Date();

  if (state.consecutiveFailures >= DOWN_THRESHOLD) {
    state.status = 'down';
  } else if (state.consecutiveFailures >= DEGRADED_THRESHOLD) {
    state.status = 'degraded';
  }
}

/** Get current health status for a provider */
export function getStatus(provider: string): HealthStatus {
  const state = providers.get(provider);
  return state?.status ?? 'healthy';
}

/** Get detailed health info for a provider */
export function getHealth(provider: string): {
  status: HealthStatus;
  consecutiveFailures: number;
  lastSuccess: Date | null;
  lastFailure: Date | null;
  avgLatencyMs: number | null;
} {
  const state = getOrCreate(provider);
  const avgLatency = state.latencyMs.length > 0
    ? state.latencyMs.reduce((a, b) => a + b, 0) / state.latencyMs.length
    : null;

  return {
    status: state.status,
    consecutiveFailures: state.consecutiveFailures,
    lastSuccess: state.lastSuccess,
    lastFailure: state.lastFailure,
    avgLatencyMs: avgLatency,
  };
}

/** Reset health state for a provider (for testing) */
export function reset(provider: string): void {
  providers.delete(provider);
}
