import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, removeTempDir, setupTestDb, teardownTestDb } from '../test-helpers.js';
import { getDb } from '../store/db.js';

let workspaceDir: string;
let dbTmpDir: string;

vi.mock('../config/index.js', () => ({
  getConfig: () => ({
    workspace: { dir: workspaceDir },
  }),
}));

import {
  executeDynamicTool,
  getAllRegisteredTools,
  getDynamicTools,
  loadDynamicToolsFromDb,
  registerDynamicTool,
  unregisterDynamicTool,
} from './dynamic-registry.js';

function createToolScript(name: string, content: string): string {
  const toolsDir = join(workspaceDir, 'tools');
  mkdirSync(toolsDir, { recursive: true });
  const scriptPath = join(toolsDir, name);
  writeFileSync(scriptPath, content, 'utf-8');
  chmodSync(scriptPath, 0o700);
  return scriptPath;
}

beforeAll(() => {
  workspaceDir = createTempDir();
  const result = setupTestDb();
  dbTmpDir = result.tmpDir;
});

beforeEach(() => {
  const db = getDb();
  db.prepare('DELETE FROM dynamic_tools').run();
  loadDynamicToolsFromDb();
  loadDynamicToolsFromDb('tenant_alpha');
  loadDynamicToolsFromDb('tenant_beta');
});

afterAll(() => {
  teardownTestDb(dbTmpDir);
  removeTempDir(workspaceDir);
});

describe('tools/dynamic-registry', () => {
  it('registers and unregisters dynamic tools in DB and runtime', () => {
    const scriptPath = createToolScript('hello_tool.sh', '#!/usr/bin/env bash\nprintf "hello"\n');

    registerDynamicTool({
      name: 'hello_tool',
      description: 'Say hello',
      parameters_schema: '{"type":"object","properties":{},"required":[],"additionalProperties":false}',
      handler_type: 'bash',
      handler_path: scriptPath,
      created_at: new Date().toISOString(),
    });

    const names = getDynamicTools().map(t => t.function.name);
    expect(names).toContain('hello_tool');

    const row = getDb()
      .prepare('SELECT name FROM dynamic_tools WHERE name = ?')
      .get('hello_tool') as { name: string } | undefined;
    expect(row?.name).toBe('hello_tool');

    unregisterDynamicTool('hello_tool');
    expect(getDynamicTools().map(t => t.function.name)).not.toContain('hello_tool');

    const deleted = getDb()
      .prepare('SELECT name FROM dynamic_tools WHERE name = ?')
      .get('hello_tool') as { name: string } | undefined;
    expect(deleted).toBeUndefined();
  });

  it('executes a dynamic bash tool with args passed via env var JSON', async () => {
    const scriptPath = createToolScript(
      'echo_args.sh',
      '#!/usr/bin/env bash\nprintf "%s" "$MOZI_DYNAMIC_TOOL_ARGS_JSON"\n',
    );

    registerDynamicTool({
      name: 'echo_args',
      description: 'Echo args',
      parameters_schema: '{"type":"object","properties":{"value":{"type":"number"}},"required":["value"],"additionalProperties":false}',
      handler_type: 'bash',
      handler_path: scriptPath,
      created_at: new Date().toISOString(),
    });

    const output = await executeDynamicTool('echo_args', { value: 42 });
    expect(output).toBe('{"value":42}');
  });

  it('retries python tools with JSON as argv[1] when positional argv parsing fails', async (ctx) => {
    try {
      execFileSync('python3', ['--version']);
    } catch {
      ctx.skip();
      return;
    }

    const scriptPath = createToolScript(
      'json_argv_tool.py',
      '#!/usr/bin/env python3\nimport json,sys\nargs = json.loads(sys.argv[1])\nprint(args.get("value", ""))\n',
    );

    registerDynamicTool({
      name: 'json_argv_tool',
      description: 'Reads args from argv[1] JSON',
      parameters_schema: '{"type":"object","properties":{"value":{"type":"string"}},"required":["value"],"additionalProperties":false}',
      handler_type: 'python',
      handler_path: scriptPath,
      created_at: new Date().toISOString(),
    });

    const output = await executeDynamicTool('json_argv_tool', { value: 'hello' });
    expect(output).toBe('hello');

    const row = getDb()
      .prepare('SELECT status, use_count, failure_count FROM dynamic_tools WHERE name = ?')
      .get('json_argv_tool') as { status: string; use_count: number; failure_count: number };
    expect(row.status).toBe('active');
    expect(row.use_count).toBe(1);
    expect(row.failure_count).toBe(0);
  });

  it('reloads dynamic tools from DB at startup', () => {
    const scriptPath = createToolScript('startup_tool.sh', '#!/usr/bin/env bash\nprintf "ok"\n');

    registerDynamicTool({
      name: 'startup_tool',
      description: 'startup',
      parameters_schema: '{"type":"object","properties":{},"required":[],"additionalProperties":false}',
      handler_type: 'bash',
      handler_path: scriptPath,
      created_at: new Date().toISOString(),
    });

    loadDynamicToolsFromDb();
    expect(getDynamicTools().map(t => t.function.name)).toContain('startup_tool');
  });

  it('promotes a draft tool to active after first successful execution', async () => {
    const scriptPath = createToolScript('lifecycle_tool.sh', '#!/usr/bin/env bash\nprintf "ok"\n');

    registerDynamicTool({
      name: 'lifecycle_tool',
      description: 'Lifecycle test',
      parameters_schema: '{"type":"object","properties":{},"required":[],"additionalProperties":false}',
      handler_type: 'bash',
      handler_path: scriptPath,
      created_at: new Date().toISOString(),
    });

    const before = getDb()
      .prepare('SELECT status, use_count FROM dynamic_tools WHERE name = ?')
      .get('lifecycle_tool') as { status: string; use_count: number };
    expect(before.status).toBe('draft');
    expect(before.use_count).toBe(0);

    await expect(executeDynamicTool('lifecycle_tool', {})).resolves.toBe('ok');

    const after = getDb()
      .prepare('SELECT status, use_count, last_used_at FROM dynamic_tools WHERE name = ?')
      .get('lifecycle_tool') as { status: string; use_count: number; last_used_at: string | null };
    expect(after.status).toBe('active');
    expect(after.use_count).toBe(1);
    expect(after.last_used_at).toBeTruthy();
  });

  it('deprecates a dynamic tool after 3 consecutive failures', async () => {
    const scriptPath = createToolScript('failing_tool.sh', '#!/usr/bin/env bash\necho "boom" >&2\nexit 1\n');

    registerDynamicTool({
      name: 'failing_tool',
      description: 'Always fails',
      parameters_schema: '{"type":"object","properties":{},"required":[],"additionalProperties":false}',
      handler_type: 'bash',
      handler_path: scriptPath,
      created_at: new Date().toISOString(),
    });

    await expect(executeDynamicTool('failing_tool', {})).rejects.toThrow('failed');
    await expect(executeDynamicTool('failing_tool', {})).rejects.toThrow('failed');
    await expect(executeDynamicTool('failing_tool', {})).rejects.toThrow('failed');

    const row = getDb()
      .prepare('SELECT status, failure_count FROM dynamic_tools WHERE name = ?')
      .get('failing_tool') as { status: string; failure_count: number };
    expect(row.status).toBe('deprecated');
    expect(row.failure_count).toBe(3);
    expect(getDynamicTools().map(t => t.function.name)).not.toContain('failing_tool');
  });

  it('gates web tools by SEARCH1API_KEY presence', () => {
    const previous = process.env.SEARCH1API_KEY;
    try {
      delete process.env.SEARCH1API_KEY;
      const withoutSearchKey = getAllRegisteredTools().map(t => t.function.name);
      expect(withoutSearchKey).not.toContain('web_search');
      expect(withoutSearchKey).not.toContain('web_fetch');

      process.env.SEARCH1API_KEY = 'test-search-key';
      const withSearchKey = getAllRegisteredTools().map(t => t.function.name);
      expect(withSearchKey).toContain('web_search');
      expect(withSearchKey).toContain('web_fetch');
    } finally {
      if (previous === undefined) {
        delete process.env.SEARCH1API_KEY;
      } else {
        process.env.SEARCH1API_KEY = previous;
      }
    }
  });

  it('isolates dynamic tools across tenants', async () => {
    const alphaScript = createToolScript('tenant_alpha_echo.sh', '#!/usr/bin/env bash\nprintf "alpha"\n');
    const betaScript = createToolScript('tenant_beta_echo.sh', '#!/usr/bin/env bash\nprintf "beta"\n');

    registerDynamicTool({
      name: 'tenant_echo',
      description: 'Echo alpha',
      parameters_schema: '{"type":"object","properties":{},"required":[],"additionalProperties":false}',
      handler_type: 'bash',
      handler_path: alphaScript,
      created_at: new Date().toISOString(),
    }, 'tenant_alpha');

    registerDynamicTool({
      name: 'tenant_echo',
      description: 'Echo beta',
      parameters_schema: '{"type":"object","properties":{},"required":[],"additionalProperties":false}',
      handler_type: 'bash',
      handler_path: betaScript,
      created_at: new Date().toISOString(),
    }, 'tenant_beta');

    expect(getDynamicTools('tenant_alpha').find(t => t.function.name === 'tenant_echo')?.function.description).toBe('Echo alpha');
    expect(getDynamicTools('tenant_beta').find(t => t.function.name === 'tenant_echo')?.function.description).toBe('Echo beta');
    expect(getDynamicTools().map(t => t.function.name)).not.toContain('tenant_echo');

    await expect(executeDynamicTool('tenant_echo', {}, 'tenant_alpha')).resolves.toBe('alpha');
    await expect(executeDynamicTool('tenant_echo', {}, 'tenant_beta')).resolves.toBe('beta');
    await expect(executeDynamicTool('tenant_echo', {}, 'default')).rejects.toThrow('not found');
  });

  it('reloads only the requested tenant registry slice', () => {
    const alphaScript = createToolScript('reload_alpha.sh', '#!/usr/bin/env bash\nprintf "alpha"\n');
    const betaScript = createToolScript('reload_beta.sh', '#!/usr/bin/env bash\nprintf "beta"\n');

    registerDynamicTool({
      name: 'reload_alpha',
      description: 'alpha',
      parameters_schema: '{"type":"object","properties":{},"required":[],"additionalProperties":false}',
      handler_type: 'bash',
      handler_path: alphaScript,
      created_at: new Date().toISOString(),
    }, 'tenant_alpha');

    registerDynamicTool({
      name: 'reload_beta',
      description: 'beta',
      parameters_schema: '{"type":"object","properties":{},"required":[],"additionalProperties":false}',
      handler_type: 'bash',
      handler_path: betaScript,
      created_at: new Date().toISOString(),
    }, 'tenant_beta');

    expect(getDynamicTools('tenant_alpha').map(t => t.function.name)).toContain('reload_alpha');
    expect(getDynamicTools('tenant_beta').map(t => t.function.name)).toContain('reload_beta');

    loadDynamicToolsFromDb('tenant_alpha');

    expect(getDynamicTools('tenant_alpha').map(t => t.function.name)).toContain('reload_alpha');
    expect(getDynamicTools('tenant_beta').map(t => t.function.name)).toContain('reload_beta');
  });
});

describe('built-in tool gating (capability truthfulness)', () => {
  it('does not register tools whose runtime preconditions are absent', async () => {
    const { getAllRegisteredTools } = await import('./dynamic-registry.js');
    const names = getAllRegisteredTools().map(t => t.function.name);

    // No coding_worker configured in the test env → advertising delegation
    // would claim a capability the runtime does not have.
    expect(names).not.toContain('delegate_coding_task');

    // Connector credentials: guard on the actual env so a dev shell with real
    // tokens doesn't produce a false failure.
    const hasConnectorEnv = [
      'SLACK_BOT_TOKEN', 'GITHUB_TOKEN', 'GMAIL_ACCESS_TOKEN',
      'GOOGLE_ACCESS_TOKEN', 'GOOGLE_CALENDAR_ACCESS_TOKEN',
    ].some(name => Boolean(process.env[name]?.trim()));
    expect(names.includes('connector_execute')).toBe(hasConnectorEnv);

    // Desktop tools follow the host GUI reality (darwin, or linux with a display).
    const guiAvailable = process.platform === 'darwin'
      || (process.platform === 'linux' && Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY));
    expect(names.includes('desktop_screenshot')).toBe(guiAvailable);
    expect(names.includes('desktop_click')).toBe(guiAvailable);

    // Playwright is a direct dependency of this repo, so browser tools register.
    expect(names).toContain('browser_open');

    // Unconditional core tools are unaffected by gating.
    expect(names).toContain('shell_exec');
    expect(names).toContain('read_file');
    expect(names).toContain('use_skill');
  });
});
