import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  clearAgentDefinitionCache,
  discoverAgentDefinitions,
  formatAgentDefinitionsCommandOutput,
  hasReadyAgentDefinitionSync,
  parseAgentDefinition,
  setAgentDefinitionState,
} from './definition-loader.js';

let root = '';
let bundledDir = '';
let workspaceDir = '';
let bundledSkillsDir = '';
let workspaceSkillsDir = '';

function writeDefinition(base: string, directory: string, content: string, disabled = false) {
  const target = join(base, directory);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'AGENT.md'), content, 'utf-8');
  if (disabled) writeFileSync(join(target, '.disabled'), 'disabled\n', 'utf-8');
}

function writeSkill(name: string) {
  const target = join(bundledSkillsDir, name);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'SKILL.md'), `---\nname: ${name}\ndescription: Test skill\n---\n\nInstructions.\n`, 'utf-8');
}

function agent(name: string, extra = '', persona = 'Act as a specialist.') {
  const fields = extra.includes('skills:') ? extra : `skills: []\n${extra}`;
  return `---\nname: ${name}\ndescription: ${name} description\n${fields}---\n\n${persona}\n`;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mozi-agent-loader-'));
  bundledDir = join(root, 'bundled');
  workspaceDir = join(root, 'workspace');
  bundledSkillsDir = join(root, 'skills');
  workspaceSkillsDir = join(root, 'workspace-skills');
  clearAgentDefinitionCache();
});

afterEach(() => {
  clearAgentDefinitionCache();
  rmSync(root, { recursive: true, force: true });
});

describe('agent definition loader', () => {
  it('formats only enabled agents for the /agents text command', async () => {
    writeDefinition(workspaceDir, 'ready', agent('ready'));
    writeDefinition(workspaceDir, 'disabled', agent('disabled'), true);
    const loaded = await discoverAgentDefinitions({
      bundledDir, workspaceDir, bundledSkillsDir, workspaceSkillsDir, useCache: false,
    });
    const output = formatAgentDefinitionsCommandOutput(loaded);
    expect(output).toBe('ready — ready description — ready');
    expect(output).not.toContain('disabled');
  });

  it('parses typed frontmatter and the persona body', () => {
    const parsed = parseAgentDefinition(agent(
      'coder',
      'model: claude-cli/sonnet\nskills:\n  - coding\ntools:\n  - shell\npermission_level: L2_SHELL_EXEC\nmetadata:\n  color: ochre\n',
      'Write focused code.',
    ));
    expect(parsed.frontmatter).toMatchObject({
      name: 'coder',
      model: 'claude-cli/sonnet',
      skills: ['coding'],
      tools: ['shell'],
      permission_level: 'L2_SHELL_EXEC',
      metadata: { color: 'ochre' },
    });
    expect(parsed.persona).toBe('Write focused code.');
  });

  it('lets workspace definitions override bundled names and reads disabled markers', async () => {
    writeDefinition(bundledDir, 'shared', agent('shared', '', 'Bundled persona.'));
    writeDefinition(workspaceDir, 'shared', agent('shared', '', 'Workspace persona.'));
    writeDefinition(workspaceDir, 'paused', agent('paused'), true);

    const loaded = await discoverAgentDefinitions({
      bundledDir, workspaceDir, bundledSkillsDir, workspaceSkillsDir, useCache: false,
    });

    expect(loaded.find(item => item.name === 'shared')).toMatchObject({
      source: 'workspace',
      persona: 'Workspace persona.',
      status: 'ready',
    });
    expect(loaded.find(item => item.name === 'paused')).toMatchObject({
      enabled: false,
      status: 'disabled',
    });
    expect(loaded.filter(item => item.name === 'shared')).toHaveLength(1);
  });

  it('keeps definitions visible as needs-setup for missing skills or unknown models', async () => {
    writeSkill('known-skill');
    writeDefinition(workspaceDir, 'valid', agent('valid', 'skills:\n  - known-skill\nmodel: claude-cli/sonnet\n'));
    writeDefinition(workspaceDir, 'setup', agent('setup', 'skills:\n  - missing-skill\nmodel: absent-provider/model\n'));

    const loaded = await discoverAgentDefinitions({
      bundledDir, workspaceDir, bundledSkillsDir, workspaceSkillsDir, useCache: false,
    });

    expect(loaded.find(item => item.name === 'valid')?.status).toBe('ready');
    expect(loaded.find(item => item.name === 'setup')).toMatchObject({
      status: 'needs-setup',
      missingSkills: ['missing-skill'],
      invalidModel: 'absent-provider/model',
    });
  });

  it('reports executable readiness only for enabled definitions with admitted skills/models', () => {
    writeSkill('known-skill');
    writeDefinition(workspaceDir, 'ready', agent('ready', 'skills:\n  - known-skill\n'));
    const paths = { bundledDir, workspaceDir, bundledSkillsDir, workspaceSkillsDir };
    expect(hasReadyAgentDefinitionSync(paths)).toBe(true);

    writeDefinition(workspaceDir, 'ready', agent('ready', 'skills:\n  - known-skill\n'), true);
    writeDefinition(workspaceDir, 'setup', agent('setup', 'skills:\n  - absent\n'));
    expect(hasReadyAgentDefinitionSync(paths)).toBe(false);
  });

  it('serves cached discovery until clearCache is called', async () => {
    const paths = { bundledDir, workspaceDir, bundledSkillsDir, workspaceSkillsDir };
    writeDefinition(workspaceDir, 'first', agent('first'));
    expect(await discoverAgentDefinitions(paths)).toHaveLength(1);
    writeDefinition(workspaceDir, 'second', agent('second'));
    expect(await discoverAgentDefinitions(paths)).toHaveLength(1);
    clearAgentDefinitionCache();
    expect(await discoverAgentDefinitions(paths)).toHaveLength(2);
  });

  it('rejects state toggles on bundled definitions instead of writing into the bundled tree', async () => {
    const paths = { bundledDir, workspaceDir, bundledSkillsDir, workspaceSkillsDir };
    writeDefinition(bundledDir, 'preset', agent('preset'));
    await expect(setAgentDefinitionState('bundled:preset', false, paths)).rejects.toMatchObject({ code: 'read_only' });
    clearAgentDefinitionCache();
    const [preset] = await discoverAgentDefinitions(paths);
    expect(preset).toMatchObject({ name: 'preset', enabled: true });
  });

  it('does not re-cache a stale scan that overlapped a mutation', async () => {
    const paths = { bundledDir, workspaceDir, bundledSkillsDir, workspaceSkillsDir };
    writeDefinition(workspaceDir, 'first', agent('first'));
    const staleScan = discoverAgentDefinitions(paths);
    clearAgentDefinitionCache();
    writeDefinition(workspaceDir, 'second', agent('second'));
    await staleScan;
    expect(await discoverAgentDefinitions(paths)).toHaveLength(2);
  });
});
