import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { ensureMoziHome, getHeartbeatPath, getPidPath } from '../paths.js';

export interface PidFileRecord {
  pid: number;
  started_at: string;
}

function parsePositiveInt(input: unknown): number | null {
  if (typeof input !== 'number') return null;
  if (!Number.isInteger(input) || input <= 0) return null;
  return input;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readPidFile(): PidFileRecord | null {
  const pidPath = getPidPath();
  if (!existsSync(pidPath)) return null;

  try {
    const parsed = JSON.parse(readFileSync(pidPath, 'utf-8')) as Record<string, unknown>;
    const pid = parsePositiveInt(parsed.pid);
    const startedAt = typeof parsed.started_at === 'string' ? parsed.started_at : null;
    if (!pid || !startedAt) return null;
    return { pid, started_at: startedAt };
  } catch {
    return null;
  }
}

export function readHeartbeatPid(): number | null {
  const heartbeatPath = getHeartbeatPath();
  if (!existsSync(heartbeatPath)) return null;

  try {
    const parsed = JSON.parse(readFileSync(heartbeatPath, 'utf-8')) as Record<string, unknown>;
    return parsePositiveInt(parsed.pid);
  } catch {
    return null;
  }
}

export function cleanupStalePidFile(): void {
  const state = readPidFile();
  if (!state) return;
  if (isProcessAlive(state.pid)) return;
  try { unlinkSync(getPidPath()); } catch { /* ignore */ }
}

export function resolveRunningPid(): number | null {
  const state = readPidFile();
  if (state?.pid && isProcessAlive(state.pid)) {
    return state.pid;
  }

  if (state) {
    try { unlinkSync(getPidPath()); } catch { /* ignore */ }
  }

  const heartbeatPid = readHeartbeatPid();
  if (heartbeatPid && isProcessAlive(heartbeatPid)) {
    return heartbeatPid;
  }

  return null;
}

export function claimPidFile(currentPid = process.pid): { ok: true } | { ok: false; existingPid: number } {
  ensureMoziHome();

  const existing = readPidFile();
  if (existing && existing.pid !== currentPid && isProcessAlive(existing.pid)) {
    return { ok: false, existingPid: existing.pid };
  }

  const record: PidFileRecord = { pid: currentPid, started_at: new Date().toISOString() };
  writeFileSync(getPidPath(), JSON.stringify(record), 'utf-8');
  return { ok: true };
}

export function releasePidFile(currentPid = process.pid): void {
  const state = readPidFile();
  if (!state) return;
  if (state.pid !== currentPid) return;
  try { unlinkSync(getPidPath()); } catch { /* ignore */ }
}
