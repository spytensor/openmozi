import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb, createTempDir, removeTempDir } from '../test-helpers.js';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  runBootstrap,
  isOnboardingCompleted,
  loadBootstrapSkills,
  loadBootstrapAgents,
  loadWorkspaceAgents,
  loadWorkspaceSkills,
  handleOnboardCommand,
  parseSkillMd,
  resetTableFlag,
} from './index.js';
import { get as getAgent } from '../agents/registry.js';

let tmpDir: string;
let bootstrapDir: string;

beforeAll(() => {
  const result = setupTestDb();
  tmpDir = result.tmpDir;
  resetTableFlag();

  // Create a mock bootstrap directory
  bootstrapDir = createTempDir();

  // Create skill directories with SKILL.md
  const skillDir = join(bootstrapDir, 'skills', 'test-skill');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), `---
id: test-skill
name: Test Skill
description: A test skill for bootstrap
version: "1.0.0"
input_schema:
  input: string
output_schema:
  output: string
---

# Test Skill

A skill used for testing bootstrap.
`);

  // Create another skill
  const skillDir2 = join(bootstrapDir, 'skills', 'another-skill');
  mkdirSync(skillDir2, { recursive: true });
  writeFileSync(join(skillDir2, 'SKILL.md'), `---
id: another-skill
name: Another Skill
description: Another test skill
version: "2.0.0"
---

# Another Skill
`);

  // Create an instruction-only skill (no script_path, no index.ts)
  const skillDir3 = join(bootstrapDir, 'skills', 'instruction-only');
  mkdirSync(skillDir3, { recursive: true });
  writeFileSync(join(skillDir3, 'SKILL.md'), `---
id: instruction-only
name: Instruction Only Skill
description: A pure instruction skill with no script
version: "1.0.0"
---

# Instruction Only

Follow these guidelines when helping with documentation:
- Always use clear headings
- Keep paragraphs short
`);

  // Create agent YAML files
  const agentDir = join(bootstrapDir, 'agents');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'test-agent.yaml'), `
id: test-agent
name: Test Agent
type: preset
system_prompt: You are a test agent.
tools_allowed:
  - filesystem
permission_level: L0_READ_ONLY
`);
});

afterAll(() => {
  teardownTestDb(tmpDir);
  removeTempDir(bootstrapDir);
});

describe('bootstrap', () => {
  describe('isOnboardingCompleted', () => {
    it('returns false initially', () => {
      expect(isOnboardingCompleted()).toBe(false);
    });
  });

  describe('loadBootstrapSkills', () => {
    it('loads skills from bootstrap directory', () => {
      const count = loadBootstrapSkills(bootstrapDir);
      expect(count).toBe(3);
    });

    it('discovers same skills on repeated calls', () => {
      const count = loadBootstrapSkills(bootstrapDir);
      expect(count).toBe(3); // File-based discovery always finds them
    });

    it('returns 0 for nonexistent directory', () => {
      const count = loadBootstrapSkills('/nonexistent');
      expect(count).toBe(0);
    });

    it('returns 0 when bootstrap has no legacy skills directory', () => {
      const emptyBootstrapDir = createTempDir();
      try {
        const count = loadBootstrapSkills(emptyBootstrapDir);
        expect(count).toBe(0);
      } finally {
        removeTempDir(emptyBootstrapDir);
      }
    });
  });

  describe('instruction-only skill bootstrap', () => {
    it('parseSkillMd extracts instruction-only skill metadata correctly', () => {
      const def = parseSkillMd(`---
id: instruction-only
name: Instruction Only Skill
description: A pure instruction skill with no script
version: "1.0.0"
---

# Instruction Only

Follow these guidelines when helping with documentation:
- Always use clear headings
- Keep paragraphs short
`, 'instruction-only');
      expect(def.kind).toBe('instruction');
      expect(def.script_path).toBeUndefined();
      expect(def.instructions_md).toContain('Follow these guidelines');
      expect(def.instructions_md).toContain('Keep paragraphs short');
    });

    it('parseSkillMd infers kind=instruction when no script_path is present', () => {
      const def = parseSkillMd(`---
id: pure-md
name: Pure MD
description: Just instructions
version: "1.0.0"
---

# Pure MD Content

Do this and that.
`, 'pure-md');
      expect(def.kind).toBe('instruction');
      expect(def.instructions_md).toContain('Do this and that.');
      expect(def.script_path).toBeUndefined();
    });

    it('parseSkillMd infers kind=module when script_path is present', () => {
      const def = parseSkillMd(`---
id: scripted
name: Scripted Skill
description: Has a script
version: "1.0.0"
script_path: run.ts
---

# Scripted
`, 'scripted');
      expect(def.kind).toBe('module');
      expect(def.script_path).toBe('run.ts');
    });
  });

  describe('loadBootstrapAgents', () => {
    it('loads agents from bootstrap directory', () => {
      const count = loadBootstrapAgents(bootstrapDir);
      expect(count).toBe(1);
    });

    it('skips already registered agents', () => {
      const count = loadBootstrapAgents(bootstrapDir);
      expect(count).toBe(0);
    });

    it('updates bootstrap preset definitions when the source YAML changes', () => {
      writeFileSync(join(bootstrapDir, 'agents', 'test-agent.yaml'), `
id: test-agent
name: Test Agent
type: preset
system_prompt: You are an updated test agent.
tools_allowed:
  - filesystem
  - shell
permission_level: L2_SHELL_EXEC
`);

      const count = loadBootstrapAgents(bootstrapDir);
      expect(count).toBe(1);
      expect(getAgent('test-agent')?.system_prompt).toContain('updated test agent');
      expect(getAgent('test-agent')?.permission_level).toBe('L2_SHELL_EXEC');
    });
  });

  describe('runBootstrap', () => {
    it('marks onboarding as completed', () => {
      // Already ran skills/agents above, but bootstrap state was reset
      resetTableFlag();
      const freshBootstrapDir = createTempDir();
      const skillDir = join(freshBootstrapDir, 'skills', 'fresh-skill');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), `---
id: fresh-skill
name: Fresh Skill
description: Fresh
version: "1.0.0"
---

# Fresh
`);

      const result = runBootstrap(freshBootstrapDir);
      expect(result.alreadyCompleted).toBe(false);
      expect(result.skillsLoaded).toBeGreaterThanOrEqual(0);
      expect(isOnboardingCompleted()).toBe(true);
      removeTempDir(freshBootstrapDir);
    });

    it('skips when already completed', () => {
      const result = runBootstrap(bootstrapDir);
      expect(result.alreadyCompleted).toBe(true);
      expect(result.skillsLoaded).toBe(0);
    });

    it('runs when forced', () => {
      const result = runBootstrap(bootstrapDir, true);
      expect(result.alreadyCompleted).toBe(false);
    });
  });

  describe('handleOnboardCommand', () => {
    it('returns completion message', () => {
      const msg = handleOnboardCommand(bootstrapDir);
      expect(msg).toContain('Bootstrap completed');
      expect(msg).toContain('skills');
      expect(msg).toContain('agents');
    });
  });

  describe('loadWorkspaceSkills', () => {
    it('loads skills from workspace/skills/ directory', () => {
      const wsDir = createTempDir();
      const skillDir = join(wsDir, 'skills', 'ws-skill');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), `---
id: ws-skill
name: Workspace Skill
description: A workspace skill
version: "1.0.0"
---

# Workspace Skill
`);

      const count = loadWorkspaceSkills(wsDir);
      expect(count).toBe(1);
      removeTempDir(wsDir);
    });

    it('discovers workspace skills consistently on repeated calls', () => {
      const wsDir = createTempDir();
      const skillDir = join(wsDir, 'skills', 'ws-skill-dup');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), `---
id: ws-skill-dup
name: Duplicate Skill
description: Test idempotency
version: "1.0.0"
---

# Duplicate Skill
`);

      const first = loadWorkspaceSkills(wsDir);
      expect(first).toBe(1);

      // File-based discovery returns the same count on re-scan
      const second = loadWorkspaceSkills(wsDir);
      expect(second).toBe(1);
      removeTempDir(wsDir);
    });

    it('creates skills dir if missing', () => {
      const wsDir = createTempDir();
      // Don't create skills/ — let loadWorkspaceSkills do it
      const count = loadWorkspaceSkills(wsDir);
      expect(count).toBe(0);
      expect(existsSync(join(wsDir, 'skills'))).toBe(true);
      removeTempDir(wsDir);
    });
  });

  describe('loadWorkspaceAgents', () => {
    it('loads agents from workspace/agents/ directory', () => {
      const wsDir = createTempDir();
      const agentDir = join(wsDir, 'agents', 'ws-agent');
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(join(agentDir, 'agent.yaml'), `
agent:
  name: Workspace Agent
  version: "1.0.0"
  description: A workspace agent
model: {}
capabilities:
  tools:
    - filesystem
system_prompt: You are a workspace agent.
`);

      const count = loadWorkspaceAgents(wsDir);
      expect(count).toBe(1);
      expect(getAgent('ws-agent')?.name).toBe('Workspace Agent');
      removeTempDir(wsDir);
    });

    it('creates agents dir if missing', () => {
      const wsDir = createTempDir();
      const count = loadWorkspaceAgents(wsDir);
      expect(count).toBe(0);
      expect(existsSync(join(wsDir, 'agents'))).toBe(true);
      removeTempDir(wsDir);
    });
  });
});
