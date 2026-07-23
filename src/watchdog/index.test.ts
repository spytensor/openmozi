import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  writeHeartbeat,
  readHeartbeat,
  checkHeartbeatAge,
  isHeartbeatStale,
  isProcessAlive,
  createWatchdog,
  type HeartbeatData,
} from './index.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mozi-watchdog-test-'));
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

describe('watchdog/heartbeat', () => {
  it('writeHeartbeat creates heartbeat file', () => {
    const path = join(tmpDir, 'heartbeat.json');
    const data: HeartbeatData = { pid: 12345, timestamp: Date.now() };
    writeHeartbeat(path, data);
    expect(existsSync(path)).toBe(true);
  });

  it('readHeartbeat reads back written data', () => {
    const path = join(tmpDir, 'heartbeat.json');
    const now = Date.now();
    const data: HeartbeatData = { pid: 42, timestamp: now };
    writeHeartbeat(path, data);

    const read = readHeartbeat(path);
    expect(read).not.toBeNull();
    expect(read!.pid).toBe(42);
    expect(read!.timestamp).toBe(now);
  });

  it('readHeartbeat returns null for nonexistent file', () => {
    const path = join(tmpDir, 'nonexistent.json');
    expect(readHeartbeat(path)).toBeNull();
  });

  it('readHeartbeat returns null for invalid JSON', () => {
    const path = join(tmpDir, 'bad.json');
    const { writeFileSync } = require('node:fs');
    writeFileSync(path, 'not json', 'utf-8');
    expect(readHeartbeat(path)).toBeNull();
  });

  it('readHeartbeat returns null for missing fields', () => {
    const path = join(tmpDir, 'incomplete.json');
    const { writeFileSync } = require('node:fs');
    writeFileSync(path, JSON.stringify({ foo: 'bar' }), 'utf-8');
    expect(readHeartbeat(path)).toBeNull();
  });

  it('writeHeartbeat with subagents', () => {
    const path = join(tmpDir, 'heartbeat.json');
    const data: HeartbeatData = {
      pid: 100,
      timestamp: Date.now(),
      subagents: {
        'agent-1': { pid: 101, timestamp: Date.now() },
        'agent-2': { pid: 102, timestamp: Date.now() },
      },
    };
    writeHeartbeat(path, data);
    const read = readHeartbeat(path);
    expect(read!.subagents).toBeDefined();
    expect(Object.keys(read!.subagents!)).toHaveLength(2);
  });

  it('writeHeartbeat creates parent directories', () => {
    const path = join(tmpDir, 'nested', 'dir', 'heartbeat.json');
    writeHeartbeat(path, { pid: 1, timestamp: Date.now() });
    expect(existsSync(path)).toBe(true);
  });
});

describe('watchdog/checkHeartbeatAge', () => {
  it('returns -1 for nonexistent file', () => {
    expect(checkHeartbeatAge(join(tmpDir, 'nope.json'))).toBe(-1);
  });

  it('returns small age for fresh heartbeat', () => {
    const path = join(tmpDir, 'hb.json');
    writeHeartbeat(path, { pid: 1, timestamp: Date.now() });
    const age = checkHeartbeatAge(path);
    expect(age).toBeGreaterThanOrEqual(0);
    expect(age).toBeLessThan(1000); // Should be < 1s
  });

  it('returns large age for old heartbeat', () => {
    const path = join(tmpDir, 'hb.json');
    writeHeartbeat(path, { pid: 1, timestamp: Date.now() - 20000 });
    const age = checkHeartbeatAge(path);
    expect(age).toBeGreaterThanOrEqual(19000);
  });
});

describe('watchdog/isHeartbeatStale', () => {
  it('fresh heartbeat is not stale', () => {
    const path = join(tmpDir, 'hb.json');
    writeHeartbeat(path, { pid: 1, timestamp: Date.now() });
    expect(isHeartbeatStale(path, 15000)).toBe(false);
  });

  it('old heartbeat is stale', () => {
    const path = join(tmpDir, 'hb.json');
    writeHeartbeat(path, { pid: 1, timestamp: Date.now() - 20000 });
    expect(isHeartbeatStale(path, 15000)).toBe(true);
  });

  it('missing file is considered stale', () => {
    expect(isHeartbeatStale(join(tmpDir, 'nope.json'), 15000)).toBe(true);
  });
});

describe('watchdog/isProcessAlive', () => {
  it('current process is alive', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('nonexistent PID is not alive', () => {
    // PID 99999 is very unlikely to exist
    expect(isProcessAlive(999999)).toBe(false);
  });
});

describe('watchdog/createWatchdog', () => {
  it('creates watchdog with default state', () => {
    const hbPath = join(tmpDir, 'hb.json');
    const wd = createWatchdog({ heartbeatPath: hbPath });
    const state = wd.getState();
    expect(state.running).toBe(false);
    expect(state.restartCount).toBe(0);
    expect(state.lastCheck).toBeNull();
    expect(state.lastRestart).toBeNull();
  });

  it('checkOnce detects stale heartbeat', async () => {
    const hbPath = join(tmpDir, 'hb.json');
    // Write an old heartbeat with a fake PID (not alive)
    writeHeartbeat(hbPath, { pid: 999999, timestamp: Date.now() - 20000 });

    const wd = createWatchdog({
      heartbeatPath: hbPath,
      staleThresholdMs: 15000,
      gracePeriodMs: 100, // Short grace for testing
    });

    const result = await wd.checkOnce();
    expect(result.stale).toBe(true);
    expect(result.action).toBe('process_dead');
    expect(wd.getState().restartCount).toBe(1);
  });

  it('checkOnce detects fresh heartbeat', async () => {
    const hbPath = join(tmpDir, 'hb.json');
    writeHeartbeat(hbPath, { pid: process.pid, timestamp: Date.now() });

    const wd = createWatchdog({
      heartbeatPath: hbPath,
      staleThresholdMs: 15000,
    });

    const result = await wd.checkOnce();
    expect(result.stale).toBe(false);
    expect(result.action).toBeNull();
    expect(wd.getState().restartCount).toBe(0);
  });

  it('start/stop controls running state', () => {
    const hbPath = join(tmpDir, 'hb.json');
    const wd = createWatchdog({
      heartbeatPath: hbPath,
      checkIntervalMs: 60000, // Long interval to avoid actual checks
    });

    wd.start();
    expect(wd.getState().running).toBe(true);

    wd.stop();
    expect(wd.getState().running).toBe(false);
  });

  it('start is idempotent', () => {
    const hbPath = join(tmpDir, 'hb.json');
    const wd = createWatchdog({
      heartbeatPath: hbPath,
      checkIntervalMs: 60000,
    });

    wd.start();
    wd.start(); // Second start should be no-op
    expect(wd.getState().running).toBe(true);
    wd.stop();
  });

  it('checkOnce handles missing heartbeat file', async () => {
    const hbPath = join(tmpDir, 'nonexistent.json');
    const wd = createWatchdog({
      heartbeatPath: hbPath,
      staleThresholdMs: 15000,
      gracePeriodMs: 100,
    });

    const result = await wd.checkOnce();
    expect(result.stale).toBe(true);
    expect(result.age).toBe(-1);
  });
});
