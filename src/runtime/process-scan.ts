import { execSync } from 'node:child_process';

/**
 * Parse `ps -ax -o pid=,command=` output and return PIDs whose command line
 * includes the given runtime entry path.
 */
export function parsePsOutputForEntry(psOutput: string, entryPath: string): number[] {
  const pids = new Set<number>();
  for (const rawLine of psOutput.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2];
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (!command.includes(entryPath)) continue;
    pids.add(pid);
  }
  return Array.from(pids);
}

/**
 * Discover running processes for a runtime entry path.
 * Returns an empty list when process listing is unavailable.
 */
export function listEntryProcessPids(entryPath: string): number[] {
  if (process.platform === 'win32') return [];
  try {
    const output = execSync('ps -ax -o pid=,command=', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parsePsOutputForEntry(output, entryPath);
  } catch {
    return [];
  }
}

