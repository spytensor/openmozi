#!/usr/bin/env node
/**
 * MOZI CLI — terminal commands for managing the agent OS.
 *
 * Usage:
 *   mozi onboard [--update] Interactive onboarding wizard (--update: config update menu)
 *   mozi start             Start the agent (auto-builds UI if needed)
 *   mozi start --daemon    Start in background
 *   mozi start --build-ui  Force rebuild Web UI before starting
 *   mozi start --skip-ui   Skip UI build check
 *   mozi stop              Stop running process
 *   mozi restart           Restart process
 *   mozi pair              Generate a pairing token
 *   mozi status [--workers] [--live-probe] [--json]
 *                         Show system status and optional worker readiness
 *   mozi help              Show all commands
 */

import { readFileSync, existsSync, copyFileSync, unlinkSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initDb, getDb, closeDb } from './store/db.js';
import { runMigrations } from './store/migrate.js';
import { createPairingToken, getAllowedUsers, hasAnyPairedUsers, approvePairingRequest, listPendingRequests } from './security/pairing.js';
import { resetOnboardingState } from './onboarding/state.js';
import { ensureMoziHome, getEnvPath, getConfigPath, getLegacyConfigPath, getMoziHome, getSecretsPath } from './paths.js';
import { loadEnvAndSecrets } from './security/secrets.js';
import { resolveMainEntryPath, startMoziInBackground } from './runtime/daemon.js';
import { isProcessAlive, readPidFile, resolveRunningPid } from './runtime/pidfile.js';
import { listEntryProcessPids } from './runtime/process-scan.js';
import { loadConfig } from './config/index.js';
import { readConfigWithLegacyFallback, writeConfigObject } from './config/storage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

// Load .env + encrypted secrets from ~/.mozi/
loadEnvAndSecrets();

const args = process.argv.slice(2);
const command = args[0];

function initDatabase() {
  ensureMoziHome();
  initDb();
  runMigrations();
}

/** Install dependencies if package.json is newer than node_modules. */
function ensureDependenciesInstalled(): void {
  const pkgJson = join(projectRoot, 'package.json');
  const modulesMarker = join(projectRoot, 'node_modules', '.modules.yaml');

  // If node_modules doesn't exist at all, definitely install
  if (!existsSync(modulesMarker)) {
    console.log('node_modules not found — installing dependencies...');
    try {
      execSync('pnpm install', { cwd: projectRoot, stdio: 'inherit' });
    } catch {
      console.error('Failed to install dependencies. Run `pnpm install` manually.');
      process.exit(1);
    }
    return;
  }

  // If package.json is newer than node_modules marker, install to pick up new deps
  try {
    const pkgMtime = statSync(pkgJson).mtimeMs;
    const modMtime = statSync(modulesMarker).mtimeMs;
    if (pkgMtime > modMtime) {
      console.log('package.json changed — installing dependencies...');
      try {
        execSync('pnpm install', { cwd: projectRoot, stdio: 'inherit' });
      } catch {
        console.warn('⚠️  Dependency install failed. Some features may not work.');
      }
    }
  } catch {
    // If we can't stat files, skip the check
  }
}

/** Rebuild backend TypeScript (tsup). Called before daemon start/restart. */
function ensureBackendBuilt(): void {
  const distIndex = join(projectRoot, 'dist', 'index.js');
  // Always rebuild — source may have changed since last build
  console.log('Building backend...');
  try {
    execSync('pnpm build', { cwd: projectRoot, stdio: 'inherit' });
  } catch {
    if (!existsSync(distIndex)) {
      console.error('Backend build failed and dist/index.js not found. Cannot start.');
      process.exit(1);
    }
    console.warn('⚠️  Backend build failed but existing dist/ found. Starting with stale build.');
  }
}

/**
 * Ensure the Web UI has been built. Auto-builds if ui/dist is missing.
 * @param forceBuild - rebuild even if ui/dist already exists
 */
function ensureUIBuilt(forceBuild: boolean): void {
  const uiIndex = join(projectRoot, 'ui', 'dist', 'index.html');
  const uiDir = join(projectRoot, 'ui');

  if (!forceBuild && existsSync(uiIndex)) {
    return;
  }

  // Skip if the ui directory doesn't exist (e.g. standalone deployment)
  if (!existsSync(join(uiDir, 'package.json'))) {
    return;
  }

  console.log(forceBuild ? 'Rebuilding Web UI...' : 'Web UI not found — building...');
  try {
    execSync('pnpm build', { cwd: uiDir, stdio: 'inherit' });
    console.log('Web UI ready.');
  } catch {
    console.warn('⚠️  Web UI build failed. The server will start without the UI.');
    console.warn('   Run `pnpm ui:build` manually to troubleshoot.');
  }
}

function cmdPair() {
  initDatabase();
  const subcommand = args[1];

  try {
    switch (subcommand) {
      case 'list':
        cmdPairList();
        break;
      case 'approve':
        cmdPairApprove();
        break;
      case 'generate':
        cmdPairGenerate();
        break;
      default:
        console.log(`
MOZI — Pairing

Usage: mozi pair <subcommand>

Subcommands:
  list                List pending pairing requests
  approve <CODE>      Approve a pairing request
  generate [--user]   Generate a legacy pairing token

Workflow:
  1. A new user sends any message to the Telegram bot
  2. Bot replies with an 8-character pairing code
  3. Run: mozi pair approve <CODE>
  4. Bot notifies the user that pairing is complete
`);
    }
  } finally {
    // Explicitly close DB to flush WAL checkpoint — ensures the running
    // server process can see newly-created tokens immediately.
    closeDb();
  }
}

function cmdPairList() {
  const tenantId = process.env.MOZI_TENANT_ID ?? 'default';
  const requests = listPendingRequests(tenantId);
  if (requests.length === 0) {
    console.log('\n  No pending pairing requests.\n  New users will get a code when they message the Telegram bot.\n');
    return;
  }

  console.log(`\n  Pending pairing requests (${requests.length}):\n`);
  console.log('  CODE      │ Username             │ User ID              │ Expires');
  console.log('  ──────────┼──────────────────────┼──────────────────────┼────────────────────');
  for (const r of requests) {
    console.log(`  ${r.code.padEnd(10)}│ ${r.username.padEnd(21)}│ ${r.userId.padEnd(21)}│ ${r.expiresAt}`);
  }
  console.log('');
  console.log('  To approve: mozi pair approve <CODE>');
  console.log('');
}

function cmdPairApprove() {
  const tenantId = process.env.MOZI_TENANT_ID ?? 'default';
  const code = args[2];
  if (!code) {
    console.error('  Usage: mozi pair approve <CODE>');
    process.exit(1);
  }

  // First user paired becomes owner, subsequent become user
  const hasPaired = hasAnyPairedUsers(tenantId);
  const role = hasPaired ? 'user' : 'owner';

  const result = approvePairingRequest(code, role, tenantId);
  if (!result) {
    console.error(`\n  ❌ Invalid, expired, or already approved code: ${code.toUpperCase()}\n`);
    console.log('  Run `mozi pair list` to see pending requests.\n');
    process.exit(1);
  }

  console.log(`\n  ✅ User ${result.username} (${result.userId}) paired as ${role}`);
  console.log('  💡 The user will receive a notification in Telegram.\n');
}

function cmdPairGenerate() {
  const tenantId = process.env.MOZI_TENANT_ID ?? 'default';
  const role = args.includes('--user') ? 'user' : 'owner';
  const token = createPairingToken(role, 30, tenantId);

  console.log('');
  console.log('  ╔══════════════════════════════════════════════════════╗');
  console.log('  ║              MOZI — Pairing Token (Legacy)          ║');
  console.log('  ╠══════════════════════════════════════════════════════╣');
  console.log(`  ║  Role: ${role.padEnd(47)}║`);
  console.log('  ║  Expires: 30 minutes                                ║');
  console.log('  ╠══════════════════════════════════════════════════════╣');
  console.log(`  ║  ${token}  ║`);
  console.log('  ╚══════════════════════════════════════════════════════╝');
  console.log('');
  console.log('  Send this token to the MOZI Telegram bot to pair.');
  console.log('  The token can only be used once.');
  console.log('');
}

function cmdUsers() {
  initDatabase();
  const tenantId = process.env.MOZI_TENANT_ID ?? 'default';
  const users = getAllowedUsers(tenantId);
  if (users.length === 0) {
    console.log('No paired users. Run `mozi pair` to generate a pairing token.');
    return;
  }
  console.log('Paired users:');
  for (const u of users) {
    console.log(`  ${u.role.padEnd(8)} ${u.username.padEnd(20)} (${u.user_id})`);
  }
}

async function cmdStatus() {
  initDatabase();
  const tenantId = process.env.MOZI_TENANT_ID ?? 'default';
  const hasPaired = hasAnyPairedUsers(tenantId);
  const users = getAllowedUsers(tenantId);
  const home = getMoziHome();
  const runningPid = resolveRunningPid();
  const includeWorkers = args.includes('--workers');
  const liveProbe = args.includes('--live-probe');
  const asJson = args.includes('--json');

  // Load config to check channel status
  let telegramConfigured = false;
  let wechatConfigured = false;
  try {
    const config = loadConfig();
    telegramConfigured = Boolean(config.telegram?.bot_token);
    wechatConfigured = Boolean(config.wechat?.bot_token);
  } catch { /* config may not exist yet */ }

  const baseStatus = {
    paired_users: users.length,
    running: Boolean(runningPid),
    running_pid: runningPid ?? null,
    home,
    database: `${home}/data/mozi.db`,
    config: `${home}/mozi.json`,
    legacy_config: existsSync(getLegacyConfigPath()) ? `${home}/config.yaml` : null,
    needs_pairing: !hasPaired,
    channels: {
      telegram: telegramConfigured ? 'configured' : 'not configured',
      wechat: wechatConfigured ? 'configured' : 'not configured',
    },
  };

  const workerReports = includeWorkers
    ? await (async () => {
      const { getDefaultWorkerAdapterRegistry, inspectAllWorkerReadiness } = await import('./workers/index.js');
      const registry = getDefaultWorkerAdapterRegistry();
      const adapters = registry
        .list()
        .map((meta) => registry.get(meta.id))
        .filter((adapter): adapter is NonNullable<typeof adapter> => Boolean(adapter));
      return inspectAllWorkerReadiness(adapters, { liveProbe });
    })()
    : [];

  if (asJson) {
    console.log(JSON.stringify({
      ...baseStatus,
      workers: workerReports,
    }, null, 2));
    return;
  }

  console.log('MOZI Status');
  console.log(`  Paired users: ${baseStatus.paired_users}`);
  console.log(`  Running: ${runningPid ? `yes (PID ${runningPid})` : 'no'}`);
  console.log(`  Home: ${home}`);
  console.log(`  Database: ${home}/data/mozi.db`);
  console.log(`  Config: ${home}/mozi.json`);
  console.log(`  Channels:`);
  console.log(`    Telegram: ${baseStatus.channels.telegram}`);
  console.log(`    WeChat:   ${baseStatus.channels.wechat}`);
  if (baseStatus.legacy_config) {
    console.log(`  Legacy config detected: ${baseStatus.legacy_config}`);
  }
  if (!hasPaired) {
    console.log('\n  ⚠️  No paired users. Run `mozi pair` first.');
  }
  if (includeWorkers) {
    console.log('\n  Managed Workers');
    for (const report of workerReports) {
      console.log(`  - ${report.adapter_id} [${report.lane}] ${report.status}`);
      console.log(`    sandbox=${report.sandbox_profile} command=${report.command_path ?? report.command ?? 'n/a'}`);
      if (report.auth_source) {
        console.log(`    auth=${report.auth_source}`);
      }
      console.log(`    health=${report.health.status}`);
      console.log(`    preflight=${report.summary}`);
      if (liveProbe) {
        console.log(`    live_probe=${report.live_probe.ok ? 'ok' : 'failed'} ${report.live_probe.summary}`);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopRunningMozi(options?: { force?: boolean; quiet?: boolean }): Promise<boolean> {
  const pid = resolveRunningPid();
  const force = options?.force ?? false;
  const quiet = options?.quiet ?? false;
  const targets = new Set<number>();

  if (pid) {
    targets.add(pid);
  }
  const runtimeEntry = resolveMainEntryPath(projectRoot) ?? resolveMainEntryPath(process.cwd());
  if (runtimeEntry) {
    for (const discovered of listEntryProcessPids(runtimeEntry)) {
      if (discovered !== process.pid) {
        targets.add(discovered);
      }
    }
  }
  const targetPids = Array.from(targets);

  if (targetPids.length === 0) {
    if (!quiet) {
      console.log('MOZI is not running.');
    }
    return false;
  }

  for (const targetPid of targetPids) {
    try {
      process.kill(targetPid, 'SIGTERM');
    } catch (err) {
      if (!quiet) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(`Failed to send SIGTERM to PID ${targetPid}: ${message}`);
      }
    }
  }

  const timeoutMs = 10_000;
  const pollMs = 200;
  const startedAt = Date.now();
  let remaining = new Set(targetPids);
  while (Date.now() - startedAt < timeoutMs) {
    remaining = new Set(Array.from(remaining).filter((targetPid) => isProcessAlive(targetPid)));
    if (remaining.size === 0) {
      if (!quiet) {
        console.log(`MOZI stopped (${targetPids.length} process${targetPids.length > 1 ? 'es' : ''}).`);
      }
      return true;
    }
    await sleep(pollMs);
  }

  if (!force) {
    if (!quiet) {
      const pidsLabel = Array.from(remaining).join(', ');
      console.log(`MOZI did not stop within ${timeoutMs / 1000}s (PID ${pidsLabel}). Use: mozi stop --force`);
    }
    return false;
  }

  for (const targetPid of remaining) {
    try {
      process.kill(targetPid, 'SIGKILL');
    } catch (err) {
      if (!quiet) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(`Failed to send SIGKILL to PID ${targetPid}: ${message}`);
      }
    }
  }

  const forceWaitStart = Date.now();
  while (Date.now() - forceWaitStart < 3_000) {
    remaining = new Set(Array.from(remaining).filter((targetPid) => isProcessAlive(targetPid)));
    if (remaining.size === 0) {
      if (!quiet) {
        console.log(`MOZI force-stopped (${targetPids.length} process${targetPids.length > 1 ? 'es' : ''}).`);
      }
      return true;
    }
    await sleep(100);
  }

  if (!quiet) {
    const pidsLabel = Array.from(remaining).join(', ');
    console.log(`MOZI is still running after SIGKILL (PID ${pidsLabel}).`);
  }
  return false;
}

async function cmdStop(): Promise<void> {
  const force = args.includes('--force');
  const hadRunning = Boolean(resolveRunningPid());
  const stopped = await stopRunningMozi({ force });
  if (hadRunning && !stopped) {
    process.exit(1);
  }
}

function buildHealthUrl(): string {
  try {
    const config = loadConfig();
    const host = config.server.host === '0.0.0.0' ? '127.0.0.1' : config.server.host;
    return `http://${host}:${config.server.port}/api/health`;
  } catch {
    return 'http://127.0.0.1:9210/api/health';
  }
}

async function isDaemonServing(pid: number): Promise<boolean> {
  if (typeof fetch !== 'function') return isProcessAlive(pid);
  try {
    const response = await fetch(buildHealthUrl(), {
      method: 'GET',
      signal: AbortSignal.timeout(800),
    });
    if (!response.ok) return false;
    const payload = await response.json() as { ok?: unknown; pid?: unknown };
    return payload.ok === true && payload.pid === pid;
  } catch {
    return false;
  }
}

async function ensureDaemonHealthy(pid: number): Promise<boolean> {
  const timeoutMs = 8_000;
  const startedAt = Date.now();
  await sleep(350);
  while (Date.now() - startedAt < timeoutMs) {
    if (!isProcessAlive(pid)) return false;
    if (await isDaemonServing(pid)) return true;
    await sleep(250);
  }
  return false;
}

async function cmdRestart(): Promise<void> {
  const daemon = args.includes('--daemon');
  const force = args.includes('--force');
  const runningPid = readPidFile()?.pid ?? resolveRunningPid();
  const runtimeEntry = resolveMainEntryPath(projectRoot) ?? resolveMainEntryPath(process.cwd());
  const discovered = runtimeEntry ? listEntryProcessPids(runtimeEntry).filter((pid) => pid !== process.pid) : [];
  const hadRunning = Boolean(runningPid) || discovered.length > 0;
  let stopped = await stopRunningMozi({ force, quiet: true });
  if (hadRunning && !stopped && !force) {
    // Restart should be reliable for the default command path.
    stopped = await stopRunningMozi({ force: true, quiet: true });
  }
  if (hadRunning && !stopped) {
    console.error('Failed to stop existing MOZI process. Aborting restart.');
    process.exit(1);
  }

  ensureDependenciesInstalled();
  if (daemon) {
    ensureBackendBuilt();
  }
  if (!args.includes('--skip-ui')) {
    ensureUIBuilt(args.includes('--build-ui'));
  }

  if (daemon) {
    const launched = startMoziInBackground();
    if (!launched.ok) {
      console.error(`Failed to start MOZI in background: ${launched.error}`);
      process.exit(1);
    }
    if (!await ensureDaemonHealthy(launched.pid)) {
      console.error(`MOZI daemon exited during startup (PID ${launched.pid}). Check logs: ${launched.logPath}`);
      process.exit(1);
    }
    console.log(`MOZI restarted in background (PID ${launched.pid}). Logs: ${launched.logPath}`);
    return;
  }

  if (runningPid) {
    console.log(`MOZI restarted (previous PID ${runningPid}).`);
  }
  await import('./index.js');
}

function getArgValue(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function cmdReset() {
  const hasFull = args.includes('--full');
  const hasSessions = args.includes('--sessions');
  const resetConfig = args.includes('--config') || hasFull || !hasSessions;
  const resetSessions = hasSessions || hasFull;

  initDatabase();
  const actions: string[] = [];

  if (resetConfig) {
    const configPaths = [getConfigPath(), getLegacyConfigPath()];
    for (const cfgPath of configPaths) {
      if (!existsSync(cfgPath)) continue;
      copyFileSync(cfgPath, cfgPath + '.bak');
      unlinkSync(cfgPath);
      actions.push(`${cfgPath} backed up and removed`);
    }
    resetOnboardingState();
    actions.push('bootstrap_state cleared');
  }

  if (resetSessions) {
    const db = getDb();
    for (const table of ['conversations', 'allowed_users', 'pairing_tokens', 'pairing_requests']) {
      try { db.prepare(`DELETE FROM ${table}`).run(); actions.push(`${table} cleared`); }
      catch { actions.push(`${table} not found (skipped)`); }
    }
  }

  console.log('\n  MOZI Reset\n  ----------');
  for (const a of actions) console.log(`  - ${a}`);
  console.log('\n  Run `mozi pair` then `mozi start` to set up again.\n');
}

function cmdConfigure() {
  initDatabase();
  const port = getArgValue('--port');
  const bind = getArgValue('--bind');
  const authToken = getArgValue('--auth-token');
  const authMode = getArgValue('--auth-mode');

  if (!port && !bind && !authToken && !authMode) {
    console.log('Usage: mozi configure [options]');
    console.log('  --port <number>       Server port');
    console.log('  --bind <host>         Bind address');
    console.log('  --auth-token <token>  WebSocket auth token');
    console.log('  --auth-mode <mode>    Auth mode: token | none');
    return;
  }

  const cfgPath = getConfigPath();
  const existing = readConfigWithLegacyFallback(cfgPath).config;
  if (!existing.server) existing.server = {};
  const server = existing.server as Record<string, unknown>;
  if (port) server.port = parseInt(port, 10);
  if (bind) server.host = bind;
  if (authToken) server.auth_token = authToken;
  if (authMode) server.auth_mode = authMode;

  writeConfigObject(cfgPath, existing);
  console.log('Configuration updated.');
}

function cmdConfigSet() {
  const key = args[1];
  const rawValue = args.slice(2).join(' ');
  if (!key || !rawValue) {
    console.error('Usage: mozi config set <key> <value>');
    console.error('');
    console.error('Examples:');
    console.error('  mozi config set tools.subagents.enabled true');
    console.error('  mozi config set brain.model claude-opus-4-6');
    console.error('  mozi config set system.max_parallel_agents 4');
    process.exit(1);
  }

  // Parse value: try number, then boolean, then string
  let value: unknown = rawValue;
  const num = Number(rawValue);
  if (!isNaN(num) && rawValue.trim() !== '') {
    value = num;
  } else if (rawValue === 'true') {
    value = true;
  } else if (rawValue === 'false') {
    value = false;
  }

  // Always persist to disk
  const cfgPath = getConfigPath();
  const existing = readConfigWithLegacyFallback(cfgPath).config;
  const keys = key.split('.');
  let target = existing as Record<string, unknown>;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!target[keys[i]] || typeof target[keys[i]] !== 'object') {
      target[keys[i]] = {};
    }
    target = target[keys[i]] as Record<string, unknown>;
  }
  target[keys[keys.length - 1]] = value;
  writeConfigObject(cfgPath, existing);

  console.log(`Config updated: ${key} = ${JSON.stringify(value)}`);
  console.log('(Restart MOZI for the change to take effect)');
}

function cmdConfigGet() {
  const key = args[1];
  if (!key) {
    // Show full config
    const cfgPath = getConfigPath();
    const existing = readConfigWithLegacyFallback(cfgPath).config;
    console.log(JSON.stringify(existing, null, 2));
    return;
  }

  const cfgPath = getConfigPath();
  const existing = readConfigWithLegacyFallback(cfgPath).config;
  const keys = key.split('.');
  let target: unknown = existing;
  for (const k of keys) {
    if (!target || typeof target !== 'object') {
      console.error(`Config path "${key}" not found.`);
      process.exit(1);
    }
    target = (target as Record<string, unknown>)[k];
  }
  if (target === undefined) {
    console.error(`Config path "${key}" not found.`);
    process.exit(1);
  }
  if (typeof target === 'object' && target !== null) {
    console.log(JSON.stringify(target, null, 2));
  } else {
    console.log(String(target));
  }
}

function cmdHelp() {
  console.log(`
MOZI — Autonomous Agent Operating System

Usage: mozi <command>

Commands:
  onboard [--accept-risk] [--update] [--auto-start|--no-auto-start] [--auto-boot|--no-auto-boot]
                            Interactive onboarding wizard (--update: jump to config update menu)
  init [--accept-risk] [--update] [--auto-start|--no-auto-start] [--auto-boot|--no-auto-boot]
                            Legacy alias for 'onboard'
  start [--daemon] [--build-ui] [--skip-ui]
                            Start MOZI (auto-builds UI if needed)
  stop [--force]            Stop running MOZI process
  restart [--daemon] [--build-ui] [--skip-ui]
                            Restart MOZI
  status [--workers] [--live-probe] [--json]
                            Show system status and optional managed-worker readiness
  pair                      Pairing management (list/approve/generate)
  pair list                 List pending pairing requests
  pair approve <CODE>       Approve a pairing request
  pair generate [--user]    Generate legacy pairing token
  users                     List paired users
  reset [--full]            Reset configuration
  configure                 Configure server settings
  config set <key> <value>  Set a config value (dot notation)
  config get [key]          Show config value (or full config)
  secrets                   Secrets management (configure/list/set/get/audit/apply/reload/export)
  pipeline                  Development pipeline (issue → verify → commit → push → close)
  acp                       Start ACP server (JSON-RPC over stdio for IDE integrations)
  mcp                       MCP bridge management (list/add/remove/test)
  service                   Auto-start service (install/uninstall/status) — survives reboot
  help                      Show this help

Quick start:
  pnpm install && pnpm build
  pnpm mozi onboard
  pnpm mozi start
`);
}

switch (command) {
  case 'pair':
    cmdPair();
    break;
  case 'users':
    cmdUsers();
    break;
  case 'status':
    await cmdStatus();
    break;
  case 'start':
    ensureDependenciesInstalled();
    if (args.includes('--daemon')) {
      ensureBackendBuilt();
    }
    if (!args.includes('--skip-ui')) {
      ensureUIBuilt(args.includes('--build-ui'));
    }
    if (args.includes('--daemon')) {
      const launched = startMoziInBackground();
      if (!launched.ok) {
        console.error(`Failed to start MOZI in background: ${launched.error}`);
        process.exit(1);
      }
      if (!await ensureDaemonHealthy(launched.pid)) {
        console.error(`MOZI daemon exited during startup (PID ${launched.pid}). Check logs: ${launched.logPath}`);
        process.exit(1);
      }
      console.log(`MOZI started in background (PID ${launched.pid}). Logs: ${launched.logPath}`);
    } else {
      // Dynamic import to avoid loading everything for CLI commands
      await import('./index.js');
    }
    break;
  case 'stop':
    await cmdStop();
    break;
  case 'restart':
    await cmdRestart();
    break;
  case 'init':
  case 'onboard': {
    if (command === 'init') {
      console.warn("`mozi init` is a legacy alias. Prefer `mozi onboard`.");
    }
    const { runWizard } = await import('./onboarding/wizard.js');
    const autoStartFlag = args.includes('--auto-start')
      ? true
      : args.includes('--no-auto-start')
        ? false
        : undefined;
    const autoBootFlag = args.includes('--auto-boot')
      ? true
      : args.includes('--no-auto-boot')
        ? false
        : undefined;
    await runWizard({
      acceptRisk: args.includes('--accept-risk'),
      autoStart: autoStartFlag,
      autoBoot: autoBootFlag,
      update: args.includes('--update'),
    });
    break;
  }
  case 'reset':
    cmdReset();
    break;
  case 'configure':
    cmdConfigure();
    break;
  case 'config': {
    const subCmd = args[1];
    switch (subCmd) {
      case 'set':
        // Shift args so cmdConfigSet sees key at args[1] and value at args[2+]
        args.splice(0, 1);
        cmdConfigSet();
        break;
      case 'get':
        args.splice(0, 1);
        cmdConfigGet();
        break;
      default:
        console.log(`
MOZI — Config Management

Usage: mozi config <subcommand>

Subcommands:
  set <key> <value>   Set a config value (dot notation)
  get [key]           Show a config value or full config

Examples:
  mozi config set tools.subagents.enabled true
  mozi config set brain.model claude-opus-4-6
  mozi config get tools.subagents
  mozi config get
`);
    }
    break;
  }
  case 'secrets': {
    const {
      cmdSecretsConfigure,
      cmdSecretsList,
      cmdSecretsSet,
      cmdSecretsGet,
      cmdSecretsApply,
      cmdSecretsReload,
      cmdSecretsExport,
      cmdSecretsAudit,
    } = await import('./security/secrets.js');
    const subCmd = args[1];
    switch (subCmd) {
      case 'configure':
        await cmdSecretsConfigure();
        break;
      case 'list':
        cmdSecretsList();
        break;
      case 'set': {
        const setKey = args[2];
        const setValue = args[3];
        if (!setKey || !setValue) {
          console.error('Usage: mozi secrets set <KEY> <VALUE>');
          process.exit(1);
        }
        await cmdSecretsSet(setKey, setValue);
        break;
      }
      case 'get': {
        const getKey = args[2];
        if (!getKey) {
          console.error('Usage: mozi secrets get <KEY> [--reveal]');
          process.exit(1);
        }
        await cmdSecretsGet(getKey, args.includes('--reveal'));
        break;
      }
      case 'apply':
        cmdSecretsApply(args.includes('--rotate'));
        break;
      case 'reload':
        cmdSecretsReload();
        break;
      case 'export':
        cmdSecretsExport();
        break;
      case 'audit':
        initDatabase();
        await cmdSecretsAudit();
        break;
      default:
        console.log(`
MOZI — Secrets Management

Usage: mozi secrets <subcommand>

Subcommands:
  configure           Generate master key + migrate .env → encrypted store
  list                List stored secret key names (no values)
  set <KEY> <VALUE>   Add or update a secret
  get <KEY> [--reveal] Show a secret (masked by default)
  apply [--rotate]    Re-encrypt with fresh IV/salt (--rotate for new master key)
  reload              Decrypt + re-inject into process.env
  export              Dump secrets as plaintext .env format (for backup)
  audit               Show audit log of secret operations
`);
    }
    break;
  }
  case 'pipeline': {
    const { cmdPipelineIssue, cmdPipelineVerify, cmdPipelineCommit, cmdPipelineClose, cmdPipelinePush, cmdPipelineRun } = await import('./pipeline.js');
    const subCmd = args[1];
    switch (subCmd) {
      case 'issue': {
        const title = args[2];
        const body = args[3] || '';
        if (!title) { console.error('Usage: mozi pipeline issue <title> [body]'); process.exit(1); }
        cmdPipelineIssue(title, body);
        break;
      }
      case 'verify':
        process.exit(cmdPipelineVerify() ? 0 : 1);
        break;
      case 'commit': {
        const num = parseInt(args[2], 10);
        const msg = args[3];
        if (!num || !msg) { console.error('Usage: mozi pipeline commit <issue#> <message>'); process.exit(1); }
        cmdPipelineCommit(num, msg);
        break;
      }
      case 'close': {
        const num = parseInt(args[2], 10);
        if (!num) { console.error('Usage: mozi pipeline close <issue#>'); process.exit(1); }
        cmdPipelineClose(num, args[3]);
        break;
      }
      case 'push':
        cmdPipelinePush();
        break;
      case 'run': {
        const title = args[2];
        const body = args[3] || '';
        if (!title) { console.error('Usage: mozi pipeline run <title> [body]'); process.exit(1); }
        cmdPipelineRun(title, body);
        break;
      }
      default:
        console.log('Usage: mozi pipeline <issue|verify|commit|close|push|run>');
        console.log('');
        console.log('  issue <title> [body]       Create GitHub issue');
        console.log('  verify                     Run build + tests');
        console.log('  commit <issue#> <message>  Commit referencing issue');
        console.log('  push                       Push to origin');
        console.log('  close <issue#> [comment]   Close GitHub issue');
        console.log('  run <title> [body]         Full pipeline: issue → verify → commit → push → close');
        break;
    }
    break;
  }
  case 'mcp': {
    const { cmdMCPList, cmdMCPAdd, cmdMCPRemove, cmdMCPTest } = await import('./mcp/cli.js');
    const subCmd = args[1];
    switch (subCmd) {
      case 'list':
        cmdMCPList();
        break;
      case 'add': {
        const id = args[2];
        const cmd = args[3];
        if (!id || !cmd) {
          console.error('Usage: mozi mcp add <id> <command> [args...]');
          process.exit(1);
        }
        cmdMCPAdd(id, cmd, args.slice(4));
        break;
      }
      case 'remove': {
        const id = args[2];
        if (!id) {
          console.error('Usage: mozi mcp remove <id>');
          process.exit(1);
        }
        cmdMCPRemove(id);
        break;
      }
      case 'test': {
        const id = args[2];
        if (!id) {
          console.error('Usage: mozi mcp test <id>');
          process.exit(1);
        }
        await cmdMCPTest(id);
        break;
      }
      default:
        console.log(`
MOZI — MCP Bridge

Usage: mozi mcp <subcommand>

Subcommands:
  list                         List configured MCP servers
  add <id> <command> [args...]  Add an MCP server
  remove <id>                  Remove an MCP server
  test <id>                    Test connection to an MCP server
`);
    }
    break;
  }
  case 'acp': {
    // ACP (Agent Client Protocol) mode — stdio-based JSON-RPC 2.0 for IDE integrations.
    // Sets MOZI_MODE so index.ts skips Telegram/Fastify and starts ACP server instead.
    process.env.MOZI_MODE = 'acp';
    ensureDependenciesInstalled();
    await import('./index.js');
    break;
  }
  case 'service': {
    const { installService, uninstallService, getServiceStatus } = await import('./runtime/service-install.js');
    const sub = args[1];
    if (sub === 'install') {
      ensureBackendBuilt();
      const res = await installService();
      if (!res.ok) {
        console.error(`Failed to install service: ${res.error}`);
        process.exit(1);
      }
      console.log(`Service installed: ${res.unitPath}`);
      if (res.started) {
        console.log(`MOZI is running. Logs: ${res.logPath}`);
      }
      if (res.platform === 'linux') {
        if (res.linger) {
          console.log('Linger is enabled — MOZI will also run while you are logged out.');
        } else {
          console.log('MOZI will start automatically when you log in.');
          console.log('To also run while logged out: sudo loginctl enable-linger $USER');
        }
      } else if (res.platform === 'darwin') {
        console.log('MOZI will start automatically on login (launchd user agent).');
      }
    } else if (sub === 'uninstall') {
      const res = await uninstallService();
      if (!res.ok) {
        console.error(`Failed to uninstall service: ${res.error}`);
        process.exit(1);
      }
      console.log(`Service uninstalled: ${res.unitPath}`);
    } else if (sub === 'status') {
      const st = await getServiceStatus();
      if (!st.installed) {
        console.log(`Service not installed (platform: ${st.platform}).`);
      } else {
        console.log(`Service unit: ${st.unitPath}`);
        console.log(`  platform: ${st.platform}`);
        console.log(`  active:   ${st.active}`);
        console.log(`  enabled:  ${st.enabled}`);
      }
    } else {
      console.log(`
MOZI — Auto-start Service

Usage: mozi service <subcommand>

Subcommands:
  install     Install + enable + start MOZI as a user service (survives reboot)
  uninstall   Stop + disable + remove the service
  status      Show installed / active / enabled state

Platform:
  Linux  → systemd user unit at ~/.config/systemd/user/mozi.service
  macOS  → launchd plist at ~/Library/LaunchAgents/ai.mozi.agent.plist
`);
    }
    break;
  }
  case 'help':
  case '--help':
  case '-h':
  case undefined:
    cmdHelp();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    cmdHelp();
    process.exit(1);
}
