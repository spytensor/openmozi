/**
 * Watchdog — Independent health checker for the MOZI main process and subagents.
 *
 * Runs as a completely separate Node.js process. Periodically checks heartbeats
 * written by the main process and subagents. If a heartbeat goes stale beyond
 * a configurable threshold, the watchdog attempts a graceful restart (SIGTERM),
 * and if that fails, a force kill (SIGKILL) followed by restart.
 *
 * Designed to be crash-resistant: minimal dependencies, no LLM calls, no DB writes.
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { getHeartbeatPath } from '../paths.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HeartbeatData {
  pid: number;
  timestamp: number;
  subagents?: Record<string, { pid: number; timestamp: number }>;
  /** Number of currently active message-processing turns (optional, backward-compatible) */
  activeTurns?: number;
}

export interface WatchdogConfig {
  /** Path to the heartbeat file written by the main process */
  heartbeatPath: string;
  /** Check interval in milliseconds (default: 5000) */
  checkIntervalMs: number;
  /** How many ms before a heartbeat is considered stale (default: 15000) */
  staleThresholdMs: number;
  /** Time to wait after SIGTERM before sending SIGKILL (ms, default: 10000) */
  gracePeriodMs: number;
  /** Command to restart the main process */
  restartCommand: string;
  /** Telegram bot token for notifications (optional) */
  telegramBotToken?: string;
  /** Telegram chat ID for notifications (optional) */
  telegramChatId?: string;
  /** Path to the main process entry point */
  mainProcessEntry: string;
}

export interface WatchdogState {
  running: boolean;
  lastCheck: number | null;
  restartCount: number;
  lastRestart: number | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_HEARTBEAT_PATH = getHeartbeatPath();
const DEFAULT_CHECK_INTERVAL_MS = 5000;
const DEFAULT_STALE_THRESHOLD_MS = 30000;
const DEFAULT_GRACE_PERIOD_MS = 10000;
const DEFAULT_MAIN_ENTRY = 'dist/index.js';

// ---------------------------------------------------------------------------
// Heartbeat writer (used by the main process)
// ---------------------------------------------------------------------------

let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start writing heartbeats from the main process.
 * Called by the main process to indicate it's alive.
 * @param getActiveTurns Optional callback returning current number of active message turns
 */
export function startHeartbeatWriter(
  heartbeatPath = DEFAULT_HEARTBEAT_PATH,
  intervalMs = 3000,
  getActiveTurns?: () => number,
): void {
  const dir = dirname(heartbeatPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const write = () => {
    const data: HeartbeatData = {
      pid: process.pid,
      timestamp: Date.now(),
      activeTurns: getActiveTurns?.() ?? 0,
    };
    writeHeartbeat(heartbeatPath, data);
  };

  write();
  heartbeatInterval = setInterval(write, intervalMs);
}

/** Stop heartbeat writing */
export function stopHeartbeatWriter(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

/** Write heartbeat data to a file atomically via tmp + rename */
export function writeHeartbeat(path: string, data: HeartbeatData): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmpPath = path + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(data), 'utf-8');
  renameSync(tmpPath, path);
}

/** Read heartbeat data from a file. Returns null if file doesn't exist or is invalid. */
export function readHeartbeat(path: string): HeartbeatData | null {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf-8');
    const data = JSON.parse(raw) as HeartbeatData;
    if (typeof data.pid !== 'number' || typeof data.timestamp !== 'number') {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

/**
 * Check if a heartbeat is stale (older than threshold).
 * Returns the age in ms, or -1 if no heartbeat found.
 */
export function checkHeartbeatAge(path: string): number {
  const data = readHeartbeat(path);
  if (!data) return -1;
  return Date.now() - data.timestamp;
}

/**
 * Determine if a heartbeat is stale beyond the given threshold.
 */
export function isHeartbeatStale(path: string, thresholdMs: number): boolean {
  const age = checkHeartbeatAge(path);
  if (age === -1) return true; // No heartbeat = stale
  return age > thresholdMs;
}

// ---------------------------------------------------------------------------
// Process management
// ---------------------------------------------------------------------------

/**
 * Check if a process with the given PID is running.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // Signal 0 = check existence
    return true;
  } catch {
    return false;
  }
}

/**
 * Attempt to gracefully stop a process (SIGTERM).
 * Returns true if the process was signaled.
 */
export function sendGracefulStop(pid: number): boolean {
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

/**
 * Force kill a process (SIGKILL).
 * Returns true if the signal was sent.
 */
export function sendForceKill(pid: number): boolean {
  try {
    process.kill(pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Notification
// ---------------------------------------------------------------------------

/**
 * Send a notification to Telegram (fire-and-forget).
 * Silently fails — the watchdog must not crash on notification failure.
 */
export async function notifyTelegram(
  botToken: string,
  chatId: string,
  message: string,
): Promise<boolean> {
  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message }),
      signal: AbortSignal.timeout(10000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Watchdog loop
// ---------------------------------------------------------------------------

/**
 * Create a watchdog instance. Does not start automatically — call start().
 */
export function createWatchdog(config: Partial<WatchdogConfig> = {}): {
  start: () => void;
  stop: () => void;
  getState: () => WatchdogState;
  checkOnce: () => Promise<{ stale: boolean; age: number; action: string | null }>;
} {
  const cfg: WatchdogConfig = {
    heartbeatPath: config.heartbeatPath ?? DEFAULT_HEARTBEAT_PATH,
    checkIntervalMs: config.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS,
    staleThresholdMs: config.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS,
    gracePeriodMs: config.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS,
    restartCommand: config.restartCommand ?? `node ${DEFAULT_MAIN_ENTRY}`,
    telegramBotToken: config.telegramBotToken,
    telegramChatId: config.telegramChatId,
    mainProcessEntry: config.mainProcessEntry ?? DEFAULT_MAIN_ENTRY,
  };

  const state: WatchdogState = {
    running: false,
    lastCheck: null,
    restartCount: 0,
    lastRestart: null,
  };

  let timer: ReturnType<typeof setInterval> | null = null;

  async function checkOnce(): Promise<{ stale: boolean; age: number; action: string | null }> {
    state.lastCheck = Date.now();
    const age = checkHeartbeatAge(cfg.heartbeatPath);
    const stale = age === -1 || age > cfg.staleThresholdMs;

    if (!stale) {
      return { stale: false, age, action: null };
    }

    // Heartbeat stale — attempt restart
    const heartbeat = readHeartbeat(cfg.heartbeatPath);
    let action: string;

    if (heartbeat && isProcessAlive(heartbeat.pid)) {
      // If there are active turns, extend grace period to avoid killing mid-request
      const effectiveGracePeriod = (heartbeat.activeTurns ?? 0) > 0
        ? Math.max(cfg.gracePeriodMs, 60_000) // At least 60s when processing requests
        : cfg.gracePeriodMs;

      if ((heartbeat.activeTurns ?? 0) > 0) {
        console.warn(`[watchdog] Process has ${heartbeat.activeTurns} active turns — extending grace period to ${effectiveGracePeriod}ms`);
      }

      // Process exists but not responsive — try graceful stop
      sendGracefulStop(heartbeat.pid);
      action = 'sigterm_sent';

      // Wait grace period then check again
      await new Promise(resolve => setTimeout(resolve, effectiveGracePeriod));

      if (isProcessAlive(heartbeat.pid)) {
        // Still alive — force kill
        sendForceKill(heartbeat.pid);
        action = 'sigkill_sent';
      }
    } else {
      action = 'process_dead';
    }

    // Spawn restart
    state.restartCount++;
    state.lastRestart = Date.now();

    // Notify via Telegram if configured
    if (cfg.telegramBotToken && cfg.telegramChatId) {
      await notifyTelegram(
        cfg.telegramBotToken,
        cfg.telegramChatId,
        `[SYSTEM] Mozi restarted after crash (restart #${state.restartCount})`,
      );
    }

    return { stale: true, age, action };
  }

  function start(): void {
    if (state.running) return;
    state.running = true;
    timer = setInterval(() => {
      checkOnce().catch(() => {
        // Watchdog must not crash
      });
    }, cfg.checkIntervalMs);
  }

  function stop(): void {
    state.running = false;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    start,
    stop,
    getState: () => ({ ...state }),
    checkOnce,
  };
}
