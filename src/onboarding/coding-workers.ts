/**
 * Coding Worker Detection — auto-detect available CLI coding tools.
 *
 * Used during onboarding to determine which external coding workers
 * (Claude Code and Codex CLI) are installed and authorized.
 * Results are persisted to mozi.json so the skill layer knows which
 * adapters are available at runtime.
 */

import { execSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { readClaudeCliCredentials, readCodexCliCredentials } from '../core/cli-credentials.js';
import { getProvider } from '../core/providers.js';

export type CodingWorkerId = 'claude_code' | 'codex_cli';
export type CodingWorkerRouting = 'auto' | CodingWorkerId;

export interface CodingWorkerProbe {
  id: CodingWorkerId;
  name: string;
  command: string;
  installed: boolean;
  commandPath: string | null;
  version: string | null;
  authorized: boolean;
  authHint: string;
  installHint: string;
}

export interface CodingWorkerConfig {
  routing: CodingWorkerRouting;
  available: CodingWorkerId[];
}

const WORKER_DEFS: {
  id: CodingWorkerId;
  name: string;
  providerId: string;
  authCheck: () => boolean;
  authHint: string;
  installHint: string;
}[] = [
  {
    id: 'claude_code',
    name: 'Claude Code',
    providerId: 'claude-cli',
    authCheck: () => readClaudeCliCredentials() !== null,
    authHint: 'Run: claude login',
    installHint: 'npm install -g @anthropic-ai/claude-code',
  },
  {
    id: 'codex_cli',
    name: 'Codex CLI',
    providerId: 'codex-cli',
    authCheck: () => readCodexCliCredentials() !== null,
    authHint: 'Run: codex login',
    installHint: 'npm install -g @openai/codex',
  },
];

function findOnPath(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;

  if (isAbsolute(trimmed)) {
    try {
      accessSync(trimmed, constants.X_OK);
      return trimmed;
    } catch {
      return null;
    }
  }

  const searchPath = process.env.PATH ?? '';
  for (const entry of searchPath.split(delimiter)) {
    if (!entry) continue;
    const candidate = join(entry, trimmed);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep searching
    }
  }
  return null;
}

function getVersion(command: string): string | null {
  try {
    const output = execSync(`${command} --version`, {
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // Extract version-like string from first line
    const match = output.trim().match(/[\d]+\.[\d]+[\w.-]*/);
    return match ? match[0] : output.trim().slice(0, 40);
  } catch {
    return null;
  }
}

/**
 * Probe all known coding worker CLIs.
 * Returns detection results for each worker (installed, authorized, version).
 */
export function detectCodingWorkers(): CodingWorkerProbe[] {
  return WORKER_DEFS.map((def) => {
    const provider = getProvider(def.providerId);
    const command = provider?.cliBackend?.command ?? def.id.replace('_', '-');
    const commandPath = findOnPath(command);
    const installed = commandPath !== null;
    const version = installed ? getVersion(commandPath!) : null;
    const authorized = installed ? def.authCheck() : false;

    return {
      id: def.id,
      name: def.name,
      command,
      installed,
      commandPath,
      version,
      authorized,
      authHint: def.authHint,
      installHint: def.installHint,
    };
  });
}

/**
 * Pick the best default routing based on what's available.
 */
export function recommendRouting(probes: CodingWorkerProbe[]): CodingWorkerRouting {
  const ready = probes.filter(p => p.installed && p.authorized);
  if (ready.length === 0) return 'auto';
  if (ready.length >= 2) return 'auto'; // let skill decide per-task
  return ready[0]!.id;
}

/**
 * Build config from probe results and user selection.
 */
export function buildCodingWorkerConfig(
  probes: CodingWorkerProbe[],
  routing: CodingWorkerRouting,
): CodingWorkerConfig {
  return {
    routing,
    available: probes.filter(p => p.installed && p.authorized).map(p => p.id),
  };
}
