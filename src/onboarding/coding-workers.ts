/**
 * Coding Worker Detection — auto-detect available CLI coding tools.
 *
 * Used during onboarding to determine which external coding workers
 * (Claude Code and Codex CLI) are installed and authorized.
 * Results are persisted to mozi.json so the skill layer knows which
 * adapters are available at runtime.
 */

import { execFile, execFileSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
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

export interface CodexCliModel {
  id: string;
  name: string;
  contextWindow?: number;
  supportsVision: boolean;
}

const execFileAsync = promisify(execFile);
const CODEX_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;
const CODEX_MODEL_DISCOVERY_MAX_BUFFER = 4 * 1024 * 1024;

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
    const output = execFileSync(command, ['--version'], {
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

export function parseCodexCliModels(output: string): CodexCliModel[] {
  const parsed = JSON.parse(output) as unknown;
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { models?: unknown }).models)) {
    throw new Error('Codex CLI returned an invalid model catalog');
  }

  const rows = (parsed as { models: unknown[] }).models;
  if (rows.length > 200) throw new Error('Codex CLI returned too many models');

  const models: CodexCliModel[] = [];
  const seen = new Set<string>();
  for (const value of rows) {
    if (!value || typeof value !== 'object') {
      throw new Error('Codex CLI returned an invalid model entry');
    }
    const row = value as Record<string, unknown>;
    if (row.visibility !== 'list') continue;
    if (
      typeof row.slug !== 'string'
      || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(row.slug)
      || typeof row.display_name !== 'string'
      || row.display_name.length === 0
      || row.display_name.length > 120
      || (row.context_window !== undefined
        && (!Number.isSafeInteger(row.context_window) || (row.context_window as number) <= 0 || (row.context_window as number) > 2_000_000))
      || (row.input_modalities !== undefined
        && (!Array.isArray(row.input_modalities) || !row.input_modalities.every(modality => typeof modality === 'string')))
    ) {
      throw new Error('Codex CLI returned an invalid visible model entry');
    }
    if (seen.has(row.slug)) continue;
    seen.add(row.slug);
    models.push({
      id: row.slug,
      name: row.display_name,
      ...(typeof row.context_window === 'number' ? { contextWindow: row.context_window } : {}),
      supportsVision: Array.isArray(row.input_modalities) && row.input_modalities.includes('image'),
    });
  }
  if (models.length === 0) throw new Error('Codex CLI returned no visible models');
  return models;
}

export async function discoverCodexCliModels(commandPath: string): Promise<CodexCliModel[]> {
  if (!isAbsolute(commandPath)) throw new Error('Codex CLI command path must be absolute');
  accessSync(commandPath, constants.X_OK);

  const childEnv: NodeJS.ProcessEnv = {};
  for (const key of ['HOME', 'PATH', 'CODEX_HOME', 'LANG', 'LC_ALL', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    if (process.env[key] !== undefined) childEnv[key] = process.env[key];
  }
  const { stdout } = await execFileAsync(commandPath, ['debug', 'models'], {
    encoding: 'utf-8',
    timeout: CODEX_MODEL_DISCOVERY_TIMEOUT_MS,
    maxBuffer: CODEX_MODEL_DISCOVERY_MAX_BUFFER,
    env: childEnv,
  });
  return parseCodexCliModels(stdout);
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
