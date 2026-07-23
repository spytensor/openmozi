import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentManifestSchema, parseManifestFile, manifestToRegistryInput } from './manifest.js';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mozi-manifest-test-'));
}

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('agents/manifest', () => {
  describe('parseManifestFile', () => {
    it('parses a valid TOML manifest with all sections', () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      writeFileSync(join(dir, 'agent.toml'), `
[agent]
name = "researcher"
version = "2.0.0"
description = "Deep research agent"
author = "mozi-team"

[model]
provider = "openai"
model = "gpt-4.1-mini"
temperature = 0.3
max_tokens = 4096

[[model.fallbacks]]
provider = "anthropic"
model = "claude-sonnet-4-20250514"

[capabilities]
tools = ["web_search", "read_file"]
allowed_domains = ["*"]

[resources]
max_tokens_per_hour = 100000
max_tool_calls_per_turn = 20
timeout_seconds = 300

[guardrails]
approval_required = ["shell_exec"]
blocked = ["git_push"]
`);

      const manifest = parseManifestFile(join(dir, 'agent.toml'));
      expect(manifest.agent.name).toBe('researcher');
      expect(manifest.agent.version).toBe('2.0.0');
      expect(manifest.agent.author).toBe('mozi-team');
      expect(manifest.model.provider).toBe('openai');
      expect(manifest.model.model).toBe('gpt-4.1-mini');
      expect(manifest.model.temperature).toBe(0.3);
      expect(manifest.model.fallbacks).toHaveLength(1);
      expect(manifest.model.fallbacks[0].provider).toBe('anthropic');
      expect(manifest.capabilities.tools).toEqual(['web_search', 'read_file']);
      expect(manifest.capabilities.allowed_domains).toEqual(['*']);
      expect(manifest.resources?.max_tokens_per_hour).toBe(100000);
      expect(manifest.guardrails?.approval_required).toEqual(['shell_exec']);
      expect(manifest.guardrails?.blocked).toEqual(['git_push']);
    });

    it('parses a valid YAML manifest', () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      writeFileSync(join(dir, 'agent.yaml'), `
agent:
  name: coder
  version: "1.0.0"
  description: Coding agent
model:
  provider: openai
  model: gpt-4.1-mini
capabilities:
  tools:
    - shell_exec
    - filesystem
`);

      const manifest = parseManifestFile(join(dir, 'agent.yaml'));
      expect(manifest.agent.name).toBe('coder');
      expect(manifest.capabilities.tools).toEqual(['shell_exec', 'filesystem']);
    });

    it('parses minimal manifest with only required fields', () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      writeFileSync(join(dir, 'agent.toml'), `
[agent]
name = "minimal"

[model]
fallbacks = []

[capabilities]
tools = []
`);

      const manifest = parseManifestFile(join(dir, 'agent.toml'));
      expect(manifest.agent.name).toBe('minimal');
      expect(manifest.agent.version).toBe('1.0.0');
      expect(manifest.agent.description).toBe('');
      expect(manifest.model.fallbacks).toEqual([]);
      expect(manifest.capabilities.tools).toEqual([]);
    });

    it('throws on missing agent.name', () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      writeFileSync(join(dir, 'agent.toml'), `
[agent]
description = "no name"
`);

      expect(() => parseManifestFile(join(dir, 'agent.toml'))).toThrow(/agent\.name/i);
    });

    it('resolves system_prompt file reference', () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      writeFileSync(join(dir, 'agent.toml'), `
[agent]
name = "prompted"

[system_prompt]
file = "SYSTEM.md"
`);
      writeFileSync(join(dir, 'SYSTEM.md'), 'You are a helpful assistant.');

      const manifest = parseManifestFile(join(dir, 'agent.toml'));
      expect(manifest.system_prompt).toBe('You are a helpful assistant.');
    });

    it('throws when system_prompt file does not exist', () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      writeFileSync(join(dir, 'agent.toml'), `
[agent]
name = "missing-prompt"

[system_prompt]
file = "NONEXISTENT.md"
`);

      expect(() => parseManifestFile(join(dir, 'agent.toml'))).toThrow(/not found/i);
    });

    it('rejects unsupported file extension', () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      writeFileSync(join(dir, 'agent.json'), '{}');

      expect(() => parseManifestFile(join(dir, 'agent.json'))).toThrow(/unsupported/i);
    });
  });

  describe('manifestToRegistryInput', () => {
    it('maps manifest fields to registry input', () => {
      const manifest = AgentManifestSchema.parse({
        agent: { name: 'test-agent', version: '1.2.0', description: 'Test', author: 'dev' },
        model: { provider: 'openai', model: 'gpt-4.1-mini' },
        capabilities: { tools: ['web_search', 'read_file'] },
      });

      const input = manifestToRegistryInput(manifest, 'test-agent', '/tmp/agents/test-agent');
      expect(input.id).toBe('test-agent');
      expect(input.name).toBe('test-agent');
      expect(input.type).toBe('preset');
      expect(input.tools_allowed).toEqual(['web_search', 'read_file']);
      expect(input.permission_level).toBe('L0_READ_ONLY');
      expect(input.created_by).toBe('manifest');
      expect((input.config as Record<string, unknown>).version).toBe('1.2.0');
      expect((input.config as Record<string, unknown>).author).toBe('dev');
    });

    it('derives L2_SHELL_EXEC when shell_exec in tools', () => {
      const manifest = AgentManifestSchema.parse({
        agent: { name: 'executor' },
        capabilities: { tools: ['shell_exec', 'read_file'] },
      });

      const input = manifestToRegistryInput(manifest, 'executor', '/tmp');
      expect(input.permission_level).toBe('L2_SHELL_EXEC');
    });

    it('derives L1_READ_WRITE when write_file in tools', () => {
      const manifest = AgentManifestSchema.parse({
        agent: { name: 'writer' },
        capabilities: { tools: ['read_file', 'write_file'] },
      });

      const input = manifestToRegistryInput(manifest, 'writer', '/tmp');
      expect(input.permission_level).toBe('L1_READ_WRITE');
    });

    it('derives L0_READ_ONLY when no write/shell tools', () => {
      const manifest = AgentManifestSchema.parse({
        agent: { name: 'reader' },
        capabilities: { tools: ['web_search'] },
      });

      const input = manifestToRegistryInput(manifest, 'reader', '/tmp');
      expect(input.permission_level).toBe('L0_READ_ONLY');
    });

    it('preserves model fallbacks in config', () => {
      const manifest = AgentManifestSchema.parse({
        agent: { name: 'multi-model' },
        model: {
          provider: 'openai',
          model: 'gpt-4.1-mini',
          fallbacks: [
            { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
          ],
        },
        capabilities: { tools: [] },
      });

      const input = manifestToRegistryInput(manifest, 'multi-model', '/tmp');
      const model = (input.config as Record<string, unknown>).model as Record<string, unknown>;
      expect(model.provider).toBe('openai');
      expect((model.fallbacks as Array<Record<string, string>>)[0].provider).toBe('anthropic');
    });

    it('includes inline system_prompt string', () => {
      const manifest = AgentManifestSchema.parse({
        agent: { name: 'inline-prompt' },
        system_prompt: 'You are a coding assistant.',
        capabilities: { tools: [] },
      });

      const input = manifestToRegistryInput(manifest, 'inline', '/tmp');
      expect(input.system_prompt).toBe('You are a coding assistant.');
    });
  });
});
