/**
 * TEL (Tool Execution Layer) — initialization module.
 * Registers built-in tool executors and SLAs.
 */

import { register as registerSla } from './sla.js';
import { registerExecutor } from './router.js';
import {
  exec as shellExec,
  getProcessStatus,
  getProcessOutput,
  sendProcessInput,
  killProcess,
} from '../capabilities/shell.js';
import * as fs from '../capabilities/filesystem.js';
import { getConfig } from '../config/index.js';
import pino from 'pino';

const logger = pino({ name: 'mozi:tel' });
let initialized = false;

/** Initialize the TEL layer: register all built-in tools and their SLAs */
export function initTel(): void {
  if (initialized) return;

  // Register SLAs from config
  const config = getConfig();
  const shellConfig = (config as {
    tools?: { shell?: { restricted?: boolean; network_isolation?: boolean; executor?: 'docker' | 'native'; docker_image?: string } };
  }).tools?.shell;
  const shellNetworkIsolation = shellConfig?.network_isolation ?? false;
  const shellExecutor = shellConfig?.executor ?? 'native';
  const shellDockerImage = shellConfig?.docker_image ?? 'alpine:3.20';
  const configuredTools = (config as { tel?: { tools?: Record<string, unknown> } }).tel?.tools ?? {};
  for (const [tool, sla] of Object.entries(configuredTools)) {
    registerSla(tool, sla as Parameters<typeof registerSla>[1]);
  }

  // Register default SLAs for built-in tools if not in config
  if (!configuredTools.shell) {
    registerSla('shell', { timeout: 60, soft_timeout: 30, retries: 1 });
  }
  if (!configuredTools.filesystem) {
    registerSla('filesystem', { timeout: 30, retries: 0 });
  }

  // Register shell executors
  registerExecutor('shell', 'execute', async (params, context) => {
    const { command, timeout, cwd, userId, restricted, enforceWorkspaceBoundary } = params as {
      command: string;
      timeout?: number;
      cwd?: string;
      userId?: string;
      restricted?: boolean;
      enforceWorkspaceBoundary?: boolean;
    };
    return shellExec(command, {
      timeout,
      cwd,
      userId,
      restricted,
      networkIsolation: shellNetworkIsolation,
      isolationMode: shellExecutor,
      dockerImage: shellDockerImage,
      permissionLevel: context?.permission_level,
      enforceWorkspaceBoundary: enforceWorkspaceBoundary ?? true,
      allowedWorkspaceRoots: context?.allowed_paths,
    });
  });

  // Register background shell executors
  registerExecutor('shell', 'execute_background', async (params, context) => {
    const { command, cwd, userId, restricted, enforceWorkspaceBoundary, chat_id, tenant_id } = params as {
      command: string;
      cwd?: string;
      userId?: string;
      restricted?: boolean;
      enforceWorkspaceBoundary?: boolean;
      chat_id?: string;
      tenant_id?: string;
    };
    return shellExec(command, {
      cwd,
      userId,
      restricted,
      networkIsolation: shellNetworkIsolation,
      isolationMode: 'native',
      background: true,
      chatId: chat_id,
      tenantId: tenant_id,
      permissionLevel: context?.permission_level,
      enforceWorkspaceBoundary: enforceWorkspaceBoundary ?? true,
      allowedWorkspaceRoots: context?.allowed_paths,
    });
  });

  registerExecutor('shell', 'process_status', async (params) => {
    const { process_id } = params as { process_id: string };
    const status = getProcessStatus(process_id);
    if (!status) throw new Error(`Process ${process_id} not found`);
    return status;
  });

  registerExecutor('shell', 'process_output', async (params) => {
    const { process_id, tail_lines } = params as { process_id: string; tail_lines?: number };
    const output = getProcessOutput(process_id, tail_lines);
    if (!output) throw new Error(`Process ${process_id} not found`);
    return output;
  });

  registerExecutor('shell', 'process_input', async (params) => {
    const { process_id, input } = params as { process_id: string; input: string };
    return sendProcessInput(process_id, input);
  });

  registerExecutor('shell', 'process_kill', async (params) => {
    const { process_id, signal } = params as { process_id: string; signal?: string };
    return killProcess(process_id, signal as NodeJS.Signals | undefined);
  });

  // Register filesystem executors
  registerExecutor('filesystem', 'read', async (params) => {
    const { path, allowed_paths } = params as { path: string; allowed_paths?: string[] };
    return { content: fs.read(path, { allowed_paths }) };
  });

  registerExecutor('filesystem', 'write', async (params) => {
    const { path, content, allowed_paths } = params as { path: string; content: string; allowed_paths?: string[] };
    return fs.write(path, content, { allowed_paths });
  });

  registerExecutor('filesystem', 'append', async (params) => {
    const { path, content, allowed_paths } = params as { path: string; content: string; allowed_paths?: string[] };
    return fs.append(path, content, { allowed_paths });
  });

  registerExecutor('filesystem', 'list', async (params) => {
    const { path, allowed_paths } = params as { path: string; allowed_paths?: string[] };
    return { entries: fs.list(path, { allowed_paths }) };
  });

  registerExecutor('filesystem', 'search', async (params) => {
    const { path, pattern, recursive, allowed_paths } = params as {
      path: string; pattern: string; recursive?: boolean; allowed_paths?: string[]
    };
    return { matches: fs.search(path, pattern, { allowed_paths, recursive }) };
  });

  registerExecutor('filesystem', 'delete', async (params) => {
    const { path, allowed_paths } = params as { path: string; allowed_paths?: string[] };
    return fs.remove(path, { allowed_paths });
  });

  // Register blackboard SLA and executors
  if (!configuredTools.blackboard) {
    registerSla('blackboard', { timeout: 5, retries: 0 });
  }

  registerExecutor('blackboard', 'read', async (params) => {
    const { read, list } = await import('../capabilities/blackboard.js');
    const p = params as { key?: string; scope?: string; tenant_id?: string };
    if (p.key) {
      return { content: read(p.key, { scope: p.scope, tenant_id: p.tenant_id }) ?? '' };
    }
    return { entries: list({ scope: p.scope, tenant_id: p.tenant_id }) };
  });

  registerExecutor('blackboard', 'write', async (params) => {
    const { write } = await import('../capabilities/blackboard.js');
    const p = params as { key: string; value: string; scope?: string; written_by?: string; tenant_id?: string };
    write(p.key, p.value, { scope: p.scope, written_by: p.written_by, tenant_id: p.tenant_id });
    return { success: true };
  });

  initialized = true;
  logger.info('TEL layer initialized');
}
