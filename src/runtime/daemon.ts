import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureMoziHome, getLogPath } from '../paths.js';
import { resolveFromProjectRoot } from './project-root.js';

export type DaemonStartResult =
  | { ok: true; pid: number; logPath: string }
  | { ok: false; error: string };

export function resolveMainEntryPath(cwd = process.cwd()): string | null {
  const candidates = [
    fileURLToPath(new URL('../index.js', import.meta.url)),
    join(cwd, 'dist', 'index.js'),
    resolveFromProjectRoot('dist', 'index.js'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function resolveDaemonCwd(entryPath: string, fallbackCwd = process.cwd()): string {
  const entryDir = dirname(entryPath);
  // dist/index.js -> project root
  if (basename(entryDir) === 'dist') {
    return dirname(entryDir);
  }
  return fallbackCwd;
}

export function startMoziInBackground(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): DaemonStartResult {
  const entry = resolveMainEntryPath(cwd);
  if (!entry) {
    return { ok: false, error: 'Cannot locate runtime entrypoint (dist/index.js).' };
  }
  const daemonCwd = resolveDaemonCwd(entry, cwd);

  try {
    ensureMoziHome();
    const logPath = getLogPath();
    mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
    const outFd = openSync(logPath, 'a');
    const child = spawn(process.execPath, [entry], {
      cwd: daemonCwd,
      env,
      detached: true,
      stdio: ['ignore', outFd, outFd],
    });

    child.unref();
    closeSync(outFd);

    if (!child.pid) {
      return { ok: false, error: 'MOZI process started but PID was not returned.' };
    }

    return { ok: true, pid: child.pid, logPath };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
