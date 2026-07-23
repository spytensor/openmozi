import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getHeartbeatPath, getPidPath } from '../paths.js';
import {
  claimPidFile,
  cleanupStalePidFile,
  readHeartbeatPid,
  readPidFile,
  releasePidFile,
  resolveRunningPid,
} from './pidfile.js';

let tmpHome = '';
let moziHomeBackup: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'mozi-pidfile-test-'));
  moziHomeBackup = process.env.MOZI_HOME;
  process.env.MOZI_HOME = tmpHome;
});

afterEach(() => {
  if (moziHomeBackup === undefined) delete process.env.MOZI_HOME;
  else process.env.MOZI_HOME = moziHomeBackup;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('runtime/pidfile', () => {
  it('claimPidFile writes current pid and releasePidFile removes it', () => {
    const claimed = claimPidFile();
    expect(claimed.ok).toBe(true);

    const state = readPidFile();
    expect(state?.pid).toBe(process.pid);
    expect(typeof state?.started_at).toBe('string');

    releasePidFile();
    expect(readPidFile()).toBeNull();
  });

  it('resolveRunningPid returns current pid when pid file is valid', () => {
    claimPidFile();
    expect(resolveRunningPid()).toBe(process.pid);
  });

  it('resolveRunningPid falls back to heartbeat when pid file is stale', () => {
    mkdirSync(join(tmpHome, 'data'), { recursive: true });
    writeFileSync(getPidPath(), JSON.stringify({ pid: 999999, started_at: new Date().toISOString() }), 'utf-8');
    writeFileSync(getHeartbeatPath(), JSON.stringify({ pid: process.pid, timestamp: Date.now() }), 'utf-8');

    expect(readHeartbeatPid()).toBe(process.pid);
    expect(resolveRunningPid()).toBe(process.pid);
    expect(existsSync(getPidPath())).toBe(false);
  });

  it('cleanupStalePidFile removes dead pid file', () => {
    mkdirSync(join(tmpHome, 'data'), { recursive: true });
    writeFileSync(getPidPath(), JSON.stringify({ pid: 999999, started_at: new Date().toISOString() }), 'utf-8');
    expect(existsSync(getPidPath())).toBe(true);
    cleanupStalePidFile();
    expect(existsSync(getPidPath())).toBe(false);
  });
});
