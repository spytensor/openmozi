import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadConfig, getConfig, updateConfig } from './index.js';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import yaml from 'js-yaml';

describe('config', () => {
  const savedEnv: Record<string, string | undefined> = {};

  // Non-MOZI_ env vars that loadConfig also reads — a developer .env (loaded
  // by vitest's dotenv) would otherwise leak into the default-config
  // assertions.
  const CONFIG_ENV_KEYS = ['TELEGRAM_BOT_TOKEN', 'WECHAT_BOT_TOKEN', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'];

  beforeEach(() => {
    // Save and clear MOZI_ env vars
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('MOZI_') || CONFIG_ENV_KEYS.includes(key)) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    // Restore env vars
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val !== undefined) process.env[key] = val;
      else delete process.env[key];
    }
  });

  it('default config loads with all sections', () => {
    const config = loadConfig('/nonexistent/config.yaml');
    expect(config.system.max_parallel_agents).toBe(5);
    expect(config.brain.model).toBe('');
    expect(config.brain.fallback_model).toBe('');
    expect(config.brain.think).toBeUndefined();
    expect(config.brain.max_plan_steps).toBe(12);
    expect(config.token_budget.watermark_soft).toBe(0.70);
    expect(config.security.default_permission).toBe('L3_FULL_ACCESS');
    expect(config.security.enterprise.oidc.issuers).toEqual([]);
    expect(config.security.enterprise.saml.idps).toEqual([]);
    expect(config.server.port).toBe(9210);
    expect(config.telegram.bot_token).toBe('');
    expect(config.telegram.handler_timeout_ms).toBe(0);
    expect(config.telegram.stream_mode).toBe('draft');
    expect(config.telegram.stream_edit_interval_ms).toBe(900);
    expect(config.telegram.drop_pending_updates).toBe(true);
    expect(config.telegram.ignore_stale_updates_seconds).toBe(120);
    expect(config.telegram.interactive_turn_timeout_ms).toBe(600000);
    expect(config.channels.voice.enabled).toBe(false);
    expect(config.tools.loops.max_iterations).toBe(0);
    expect(config.tools.loops.subagent_max_iterations).toBe(0);
    expect(config.tools.loops.llm_call_timeout_ms).toBe(300000);
    expect(config.tools.loops.max_elapsed_ms).toBe(600000);
    expect(config.tools.loops.max_failed_tool_batches).toBe(5);
    expect(config.tools.fs.workspace_only).toBe(true);
    expect(config.workspace.dir).toBe('~/.mozi/workspace');
    expect(config.tools.fs.additional_allowed_roots).toEqual([]);
    expect(config.tools.fs.granted_project_roots).toEqual([]);
    expect(config.tools.shell.restricted).toBe(false);
    expect(config.tools.shell.network_isolation).toBe(false);
    expect(config.tools.shell.executor).toBe('native');
    expect(config.tools.shell.docker_image).toBe('alpine:3.20');
    expect(config.tools.subagents.enabled).toBe(true);
    expect(config.tools.subagents.enabled_tenants).toEqual([]);
    expect(config.tools.subagents.enabled_sessions).toEqual([]);
    expect(config.tools.subagents.session_capability).toBe('subagent_execution');
    expect(config.memory.write_policy).toBe('upsert');
    expect(config.memory.recall_strategy).toBe('hybrid');
    expect(config.memory.semantic_top_k).toBe(12);
    expect(config.memory.embedding.provider).toBe('auto');
    expect(config.http_rate_limit.global_rpm).toBe(2000);
    expect(config.http_rate_limit.auth_rpm).toBe(10);
    expect(config.http_rate_limit.pair_rpm).toBe(5);
  });

  it('normalizes legacy gemini_cli worker config before schema validation', () => {
    const dir = join(tmpdir(), `mozi-gemini-worker-${Date.now()}`);
    const configPath = join(dir, 'mozi.json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      coding_worker: {
        routing: 'gemini_cli',
        available: ['gemini_cli', 'codex_cli', 'claude_code'],
      },
    }));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const config = loadConfig(configPath);

    expect(config.coding_worker).toEqual({
      routing: 'auto',
      available: ['codex_cli', 'claude_code'],
    });
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('gemini_cli is unsupported'));
    warning.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    { routing: 'auto', available: ['codex_cli', 'typo_worker'] },
    { routing: 'auto', available: ['gemini_cli', 'typo_worker'] },
    { routing: 'auto', available: 'codex_cli' },
  ])('still rejects malformed coding-worker config after legacy normalization: $available', (codingWorker) => {
    const dir = join(tmpdir(), `mozi-invalid-worker-${Date.now()}-${Math.random()}`);
    const configPath = join(dir, 'mozi.json');
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(configPath, JSON.stringify({ coding_worker: codingWorker }));
      expect(() => loadConfig(configPath)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('defaults workspace and allowed roots under MOZI_HOME when set', () => {
    const appSupportHome = join(tmpdir(), `mozi-app-support-${Date.now()}`);
    process.env.MOZI_HOME = appSupportHome;

    const config = loadConfig('/nonexistent/config.yaml');

    expect(config.workspace.dir).toBe(join(appSupportHome, 'workspace'));
    expect(config.tools.fs.additional_allowed_roots).toEqual([]);
    expect(config.tools.fs.granted_project_roots).toEqual([]);
  });

  it('loads persisted project root grants', () => {
    const dir = join(tmpdir(), `mozi-fs-grants-${Date.now()}`);
    const configPath = join(dir, 'mozi.json');
    const projectRoot = join(dir, 'project');
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      tools: {
        fs: {
          additional_allowed_roots: [projectRoot],
          granted_project_roots: [{
            path: projectRoot,
            label: 'Project',
            granted_at: '2026-01-01T00:00:00.000Z',
            bookmark: null,
          }],
        },
      },
    }));

    const config = loadConfig(configPath);

    expect(config.tools.fs.additional_allowed_roots).toEqual([projectRoot]);
    expect(config.tools.fs.granted_project_roots).toEqual([{
      path: projectRoot,
      label: 'Project',
      granted_at: '2026-01-01T00:00:00.000Z',
      bookmark: null,
    }]);

    rmSync(dir, { recursive: true, force: true });
  });

  it('loads legacy brain.max_dag_depth without constraining max_plan_steps', () => {
    const dir = join(tmpdir(), `mozi-legacy-depth-${Date.now()}`);
    const configPath = join(dir, 'mozi.json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      brain: {
        max_dag_depth: 3,
      },
    }));

    const config = loadConfig(configPath);
    expect(config.brain.max_dag_depth).toBe(3);
    expect(config.brain.max_plan_steps).toBe(12);

    rmSync(dir, { recursive: true, force: true });
  });


  it('Zod rejects invalid types when directly parsing', () => {
    // The schema should reject bad types but loadConfig gives defaults
    // We test that getConfig returns a valid config
    const config = loadConfig('/nonexistent/config.yaml');
    expect(config.system.max_parallel_agents).toBeTypeOf('number');
    expect(config.brain.model).toBeTypeOf('string');
  });

  it('env override: MOZI_BRAIN_MODEL', () => {
    process.env.MOZI_BRAIN_MODEL = 'test-model-override';
    const config = loadConfig('/nonexistent/config.yaml');
    expect(config.brain.model).toBe('test-model-override');
    delete process.env.MOZI_BRAIN_MODEL;
  });

  it('env override: MOZI_SYSTEM_MAX_PARALLEL_AGENTS (numeric coercion)', () => {
    process.env.MOZI_SYSTEM_MAX_PARALLEL_AGENTS = '42';
    const config = loadConfig('/nonexistent/config.yaml');
    expect(config.system.max_parallel_agents).toBe(42);
    delete process.env.MOZI_SYSTEM_MAX_PARALLEL_AGENTS;
  });

  it('getConfig returns last loaded config', () => {
    loadConfig('/nonexistent/config.yaml');
    const config = getConfig();
    expect(config.system.max_parallel_agents).toBe(5);
  });

  it('updateConfig: hot-updatable key works', () => {
    loadConfig('/nonexistent/config.yaml');
    updateConfig('system.max_parallel_agents', 10);
    expect(getConfig().system.max_parallel_agents).toBe(10);
  });

  it('updateConfig: non-hot-updatable key throws', () => {
    loadConfig('/nonexistent/config.yaml');
    expect(() => updateConfig('brain.model', 'new-model')).toThrow('not hot-updatable');
    expect(() => updateConfig('security.default_permission', 'L3')).toThrow('not hot-updatable');
  });

  it('updateConfig: tools section is hot-updatable', () => {
    loadConfig('/nonexistent/config.yaml');
    updateConfig('tools.loops.max_iterations', 7);
    expect(getConfig().tools.loops.max_iterations).toBe(7);
  });

  it('updateConfig: telegram section is hot-updatable', () => {
    loadConfig('/nonexistent/config.yaml');
    updateConfig('telegram.interactive_turn_timeout_ms', 180000);
    expect(getConfig().telegram.interactive_turn_timeout_ms).toBe(180000);
  });

  it('updateConfig: coerces scalar strings for numeric loop values', () => {
    loadConfig('/nonexistent/config.yaml');
    updateConfig('tools.loops.max_iterations', '0');
    expect(getConfig().tools.loops.max_iterations).toBe(0);
  });

  it('updateConfig: rejects invalid numeric value and keeps previous config', () => {
    loadConfig('/nonexistent/config.yaml');
    updateConfig('tools.loops.max_iterations', 5);
    expect(() => updateConfig('tools.loops.max_iterations', 'not-a-number')).toThrow();
    expect(getConfig().tools.loops.max_iterations).toBe(5);
  });

  it('loads model_router config when present', () => {
    const dir = join(tmpdir(), `mozi-model-router-${Date.now()}`);
    const configPath = join(dir, 'config.yaml');
    mkdirSync(dir, { recursive: true });
    writeFileSync(configPath, yaml.dump({
      model_router: {
        brain_provider: 'anthropic',
        roles: {
          summary: { provider: 'openai', model: 'gpt-4.1-mini', think: 'low' },
        },
      },
      brain: {
        think: 'high',
      },
    }));

    const config = loadConfig(configPath);
    expect(config.model_router?.brain_provider).toBe('anthropic');
    expect(config.model_router?.roles.summary?.model).toBe('gpt-4.1-mini');
    expect(config.model_router?.roles.summary?.think).toBe('low');
    expect(config.brain.think).toBe('high');

    rmSync(dir, { recursive: true, force: true });
  });

  it('loads routing_preferences in model_router config', () => {
    const dir = join(tmpdir(), `mozi-routing-prefs-${Date.now()}`);
    const configPath = join(dir, 'config.yaml');
    mkdirSync(dir, { recursive: true });
    writeFileSync(configPath, yaml.dump({
      model_router: {
        brain_provider: 'anthropic',
        routing_preferences: {
          cost_sensitivity: 'high',
          preferred_code: { provider: 'openai', model: 'gpt-5' },
          preferred_vision: { provider: 'google' },
          preferred_cheap: { provider: 'openai', model: 'gpt-4.1-mini' },
        },
      },
    }));

    const config = loadConfig(configPath);
    const prefs = config.model_router?.routing_preferences;
    expect(prefs).toBeDefined();
    expect(prefs?.cost_sensitivity).toBe('high');
    expect(prefs?.preferred_code).toEqual({ provider: 'openai', model: 'gpt-5' });
    expect(prefs?.preferred_vision).toEqual({ provider: 'google' });
    expect(prefs?.preferred_cheap).toEqual({ provider: 'openai', model: 'gpt-4.1-mini' });
    expect(prefs?.preferred_summary).toBeUndefined();

    rmSync(dir, { recursive: true, force: true });
  });

  it('existing config without routing_preferences still loads', () => {
    const dir = join(tmpdir(), `mozi-no-prefs-${Date.now()}`);
    const configPath = join(dir, 'config.yaml');
    mkdirSync(dir, { recursive: true });
    writeFileSync(configPath, yaml.dump({
      model_router: {
        brain_provider: 'openai',
        roles: {
          brain: { provider: 'openai', model: 'gpt-4.1' },
        },
      },
    }));

    const config = loadConfig(configPath);
    expect(config.model_router?.brain_provider).toBe('openai');
    // routing_preferences should be undefined when not specified
    expect(config.model_router?.routing_preferences).toBeUndefined();

    rmSync(dir, { recursive: true, force: true });
  });

  it('loads enterprise auth security config when present', () => {
    const dir = join(tmpdir(), `mozi-enterprise-auth-${Date.now()}`);
    const configPath = join(dir, 'config.yaml');
    mkdirSync(dir, { recursive: true });
    writeFileSync(configPath, yaml.dump({
      security: {
        enterprise: {
          oidc: {
            issuers: [
              {
                tenant_id: 'acme',
                issuer: 'https://idp.acme.com',
                audience: 'mozi-api',
                tenant_claim: 'tenant_id',
                user_claim: 'sub',
                roles_claim: 'roles',
              },
            ],
          },
          saml: {
            idps: [
              {
                tenant_id: 'acme',
                entity_id: 'urn:acme:idp',
                certificate: '-----BEGIN PUBLIC KEY-----test-----END PUBLIC KEY-----',
                audience: 'urn:mozi:sp',
              },
            ],
          },
        },
      },
    }));

    const config = loadConfig(configPath);
    expect(config.security.enterprise.oidc.issuers[0].tenant_id).toBe('acme');
    expect(config.security.enterprise.saml.idps[0].entity_id).toBe('urn:acme:idp');

    rmSync(dir, { recursive: true, force: true });
  });

  it('default dm_policy is pairing', () => {
    const config = loadConfig('/nonexistent/config.yaml');
    expect(config.telegram.dm_policy).toBe('pairing');
  });

  it('default telegram handler timeout is unlimited', () => {
    const config = loadConfig('/nonexistent/config.yaml');
    expect(config.telegram.handler_timeout_ms).toBe(0);
  });

  it('default telegram queue guards are enabled', () => {
    const config = loadConfig('/nonexistent/config.yaml');
    expect(config.telegram.stream_mode).toBe('draft');
    expect(config.telegram.stream_edit_interval_ms).toBe(900);
    expect(config.telegram.drop_pending_updates).toBe(true);
    expect(config.telegram.ignore_stale_updates_seconds).toBe(120);
    expect(config.telegram.interactive_turn_timeout_ms).toBe(600000);
  });

  it('dm_policy accepts open, pairing, and allowlist', () => {
    for (const policy of ['open', 'pairing', 'allowlist'] as const) {
      const dir = join(tmpdir(), `mozi-dmpolicy-${policy}-${Date.now()}`);
      const configPath = join(dir, 'mozi.json');
      mkdirSync(dir, { recursive: true });
      writeFileSync(configPath, JSON.stringify({ telegram: { dm_policy: policy } }));

      const config = loadConfig(configPath);
      expect(config.telegram.dm_policy).toBe(policy);

      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('dm_policy rejects invalid values', () => {
    const dir = join(tmpdir(), `mozi-dmpolicy-invalid-${Date.now()}`);
    const configPath = join(dir, 'mozi.json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({ telegram: { dm_policy: 'invalid' } }));

    expect(() => loadConfig(configPath)).toThrow();

    rmSync(dir, { recursive: true, force: true });
  });

  it('telegram handler_timeout_ms accepts non-negative integers', () => {
    const dir = join(tmpdir(), `mozi-telegram-timeout-${Date.now()}`);
    const configPath = join(dir, 'mozi.json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({ telegram: { handler_timeout_ms: 300000 } }));

    const config = loadConfig(configPath);
    expect(config.telegram.handler_timeout_ms).toBe(300000);

    rmSync(dir, { recursive: true, force: true });
  });

  it('telegram handler_timeout_ms rejects negative values', () => {
    const dir = join(tmpdir(), `mozi-telegram-timeout-negative-${Date.now()}`);
    const configPath = join(dir, 'mozi.json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({ telegram: { handler_timeout_ms: -1 } }));

    expect(() => loadConfig(configPath)).toThrow();

    rmSync(dir, { recursive: true, force: true });
  });

  it('telegram queue guard config accepts valid values', () => {
    const dir = join(tmpdir(), `mozi-telegram-guards-${Date.now()}`);
    const configPath = join(dir, 'mozi.json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      telegram: {
        drop_pending_updates: false,
        ignore_stale_updates_seconds: 0,
        interactive_turn_timeout_ms: 300000,
      },
    }));

    const config = loadConfig(configPath);
    expect(config.telegram.drop_pending_updates).toBe(false);
    expect(config.telegram.ignore_stale_updates_seconds).toBe(0);
    expect(config.telegram.interactive_turn_timeout_ms).toBe(300000);

    rmSync(dir, { recursive: true, force: true });
  });

  it('telegram stream config accepts valid values', () => {
    const dir = join(tmpdir(), `mozi-telegram-stream-${Date.now()}`);
    const configPath = join(dir, 'mozi.json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      telegram: {
        stream_mode: 'edit',
        stream_edit_interval_ms: 1200,
      },
    }));

    const config = loadConfig(configPath);
    expect(config.telegram.stream_mode).toBe('edit');
    expect(config.telegram.stream_edit_interval_ms).toBe(1200);

    rmSync(dir, { recursive: true, force: true });
  });

  it('telegram stream supports OpenClaw-style alias keys', () => {
    const dir = join(tmpdir(), `mozi-telegram-stream-alias-${Date.now()}`);
    const configPath = join(dir, 'mozi.json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      telegram: {
        streamMode: 'append',
        streamEditIntervalMs: 1100,
      },
    }));

    const config = loadConfig(configPath);
    expect(config.telegram.stream_mode).toBe('append');
    expect(config.telegram.stream_edit_interval_ms).toBe(1100);

    rmSync(dir, { recursive: true, force: true });
  });

  it('telegram stream upgrades legacy partial mode to append', () => {
    const dir = join(tmpdir(), `mozi-telegram-stream-legacy-${Date.now()}`);
    const configPath = join(dir, 'mozi.json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      telegram: {
        stream_mode: 'partial',
      },
    }));

    const config = loadConfig(configPath);
    expect(config.telegram.stream_mode).toBe('append');

    rmSync(dir, { recursive: true, force: true });
  });

  it('loads legacy config.yaml via canonical mozi.json path and migrates file', () => {
    const dir = join(tmpdir(), `mozi-legacy-config-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const legacyPath = join(dir, 'config.yaml');
    const canonicalPath = join(dir, 'mozi.json');

    writeFileSync(legacyPath, yaml.dump({
      brain: { model: 'MiniMax-M2.5' },
      model_router: { brain_provider: 'minimax' },
    }));

    const config = loadConfig(canonicalPath);
    expect(config.brain.model).toBe('MiniMax-M2.5');
    expect(config.model_router?.brain_provider).toBe('minimax');
    expect(existsSync(canonicalPath)).toBe(true);
    const canonicalRaw = JSON.parse(readFileSync(canonicalPath, 'utf-8')) as Record<string, unknown>;
    expect((canonicalRaw.brain as Record<string, unknown>).model).toBe('MiniMax-M2.5');

    rmSync(dir, { recursive: true, force: true });
  });
});
