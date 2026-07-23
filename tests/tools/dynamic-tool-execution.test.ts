import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, removeTempDir, setupTestDb, teardownTestDb } from '../../src/test-helpers.js';
import { getDb } from '../../src/store/db.js';
import { loadDynamicToolsFromDb } from '../../src/tools/dynamic-registry.js';

let workspaceDir: string;
let dbTmpDir: string;

vi.mock('../../src/config/index.js', () => ({
  getConfig: () => ({
    workspace: { dir: workspaceDir },
  }),
}));

import { executeTool } from '../../src/tools/executor.js';
import type { ToolCall } from '../../src/core/llm.js';

const fullAccessContext = {
  tenantId: 'default',
  agentId: 'dynamic-tool-test',
  permissionLevel: 'L3_FULL_ACCESS',
} as const;

function makeToolCall(name: string, args: Record<string, unknown>): ToolCall {
  return {
    id: `call_${Date.now()}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

function createScript(name: string, content: string): string {
  const toolsDir = join(workspaceDir, 'tools');
  mkdirSync(toolsDir, { recursive: true });

  const scriptPath = join(toolsDir, name);
  writeFileSync(scriptPath, content, 'utf-8');
  chmodSync(scriptPath, 0o700);
  return scriptPath;
}

function insertDynamicToolRow(params: {
  name: string;
  description: string;
  handlerType: 'bash' | 'python';
  handlerPath: string;
  parametersSchema: string;
}): void {
  getDb().prepare(`
    INSERT INTO dynamic_tools (
      tenant_id,
      name,
      description,
      parameters_schema,
      handler_type,
      handler_path,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'default',
    params.name,
    params.description,
    params.parametersSchema,
    params.handlerType,
    params.handlerPath,
    new Date().toISOString(),
  );
}

beforeAll(() => {
  workspaceDir = createTempDir();
  const db = setupTestDb();
  dbTmpDir = db.tmpDir;
});

beforeEach(() => {
  getDb().prepare('DELETE FROM dynamic_tools').run();
  loadDynamicToolsFromDb();
});

afterAll(() => {
  teardownTestDb(dbTmpDir);
  removeTempDir(workspaceDir);
});

describe('dynamic tool execution fallback', () => {
  it('executes a persisted bash tool from dynamic_tools with positional args', async () => {
    const scriptPath = createScript('echo_input.sh', '#!/usr/bin/env bash\necho "$1"\n');

    insertDynamicToolRow({
      name: 'echo_input',
      description: 'Echo first argument',
      handlerType: 'bash',
      handlerPath: scriptPath,
      parametersSchema: '{"type":"object","properties":{"input":{"type":"string"}},"required":["input"],"additionalProperties":false}',
    });

    const result = await executeTool(makeToolCall('echo_input', { input: 'hello' }), fullAccessContext);

    expect(result.is_error).toBe(false);
    expect(result.content).toBe('hello');
  });

  it('returns script failures as tool errors', async () => {
    const scriptPath = createScript('failing_tool.sh', '#!/usr/bin/env bash\necho "boom" 1>&2\nexit 1\n');

    insertDynamicToolRow({
      name: 'failing_tool',
      description: 'Always fails',
      handlerType: 'bash',
      handlerPath: scriptPath,
      parametersSchema: '{"type":"object","properties":{},"required":[],"additionalProperties":false}',
    });

    const result = await executeTool(makeToolCall('failing_tool', {}), fullAccessContext);

    expect(result.is_error).toBe(true);
    expect(result.content).toContain('Dynamic tool "failing_tool" failed: boom');
  });

  it('keeps unknown tool behavior when no dynamic row exists', async () => {
    const result = await executeTool(makeToolCall('missing_dynamic_tool', {}), fullAccessContext);

    expect(result.is_error).toBe(true);
    expect(result.content).toBe('Error: Unknown tool "missing_dynamic_tool"');
  });
});
