/**
 * Central path resolver for all MOZI runtime files.
 *
 * All runtime data lives under `~/.mozi/` (or `$MOZI_HOME`).
 * This module is the single source of truth — no other module
 * should hardcode runtime paths.
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync } from 'node:fs';

/** Root directory for all MOZI runtime data. */
export function getMoziHome(): string {
  return process.env.MOZI_HOME || join(homedir(), '.mozi');
}

/** Legacy pre-desktop MOZI home. Kept for migration and compatibility checks. */
export function getLegacyMoziHome(): string {
  return join(homedir(), '.mozi');
}

/** Default workspace follows explicit MOZI_HOME, otherwise preserves the legacy config string. */
export function getDefaultWorkspaceDir(): string {
  return process.env.MOZI_HOME ? join(getMoziHome(), 'workspace') : '~/.mozi/workspace';
}

/** Default output directory for generated artifacts and intermediate files. */
export function getDefaultOutputDir(): string {
  return join(getMoziHome(), 'output');
}

/** Server-owned snapshot directory for one registered deliverable. */
export function getDeliverableVersionsDir(deliverableId: string): string {
  return join(getMoziHome(), 'versions', deliverableId);
}

/** Project grants are persisted explicitly; new configs should not allow all of MOZI_HOME. */
export function getDefaultAllowedRoots(): string[] {
  return [];
}

/** Path to the .env file (API keys, secrets). */
export function getEnvPath(): string {
  return join(getMoziHome(), '.env');
}

/** Canonical config path (`~/.mozi/mozi.json`). */
export function getConfigPath(): string {
  return join(getMoziHome(), 'mozi.json');
}

/** Legacy config path (`~/.mozi/config.yaml`) kept for backward compatibility. */
export function getLegacyConfigPath(): string {
  return join(getMoziHome(), 'config.yaml');
}

/**
 * Resolve readable config path.
 *
 * Prefers canonical `mozi.json`; falls back to legacy `config.yaml` if present.
 * Returns canonical path if neither exists.
 */
export function getReadableConfigPath(): string {
  const canonical = getConfigPath();
  if (existsSync(canonical)) return canonical;
  const legacy = getLegacyConfigPath();
  if (existsSync(legacy)) return legacy;
  return canonical;
}

/** Path to the SQLite database. */
export function getDbPath(): string {
  return join(getMoziHome(), 'data', 'mozi.db');
}

/** Path to the watchdog heartbeat file. */
export function getHeartbeatPath(): string {
  return join(getMoziHome(), 'data', 'heartbeat.json');
}

/** Path to the main MOZI process PID file. */
export function getPidPath(): string {
  return join(getMoziHome(), 'data', 'mozi.pid');
}

/** Path to the main MOZI runtime log file. */
export function getLogPath(): string {
  return join(getMoziHome(), 'logs', 'mozi.log');
}

/** Path to the encrypted secrets store. */
export function getSecretsPath(): string {
  return join(getMoziHome(), 'secrets.enc');
}

/** Path to the master key file for secrets encryption. */
export function getMasterKeyPath(): string {
  return join(getMoziHome(), '.master-key');
}

/** Path to the persisted JWT signing secret file. Configurable via MOZI_JWT_SECRET_PATH. */
export function getJwtSecretPath(): string {
  return process.env.MOZI_JWT_SECRET_PATH || join(getMoziHome(), 'jwt-secret');
}

/**
 * Shared runtime environment for skill dependencies (npm/pip packages declared
 * in a skill's `install:` manifest). Kept OUTSIDE workspace/output so it is not
 * subject to workspace_only path gating and is not wiped with generated
 * artifacts. `getSkillNodeModulesDir` is injected onto NODE_PATH for every shell
 * command so scripts the Brain writes can `require()` provisioned packages
 * without a local install.
 *
 * Python is deliberately not exposed here. Its overlay must be keyed by
 * interpreter identity (ABI/platform/architecture) rather than shared as one
 * flat directory — see `runtime/python-env.ts` for why, and use
 * `getSkillPythonRoot()` / `resolveManagedPythonEnv()` from that module.
 */
export function getSkillRuntimeDir(): string {
  return join(getMoziHome(), 'skill-runtime');
}

/** node_modules root where skill npm dependencies are installed. */
export function getSkillNodeModulesDir(): string {
  return join(getSkillRuntimeDir(), 'node_modules');
}

/**
 * Create `~/.mozi/` and subdirectories with secure permissions.
 * Safe to call multiple times (idempotent).
 */
export function ensureMoziHome(): void {
  const home = getMoziHome();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(join(home, 'data'), { recursive: true, mode: 0o700 });
  mkdirSync(join(home, 'output'), { recursive: true, mode: 0o700 });
  mkdirSync(join(home, 'workspace'), { recursive: true, mode: 0o700 });
}
