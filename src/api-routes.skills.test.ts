import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerApiRoutes } from './api-routes.js';
import { getConfigPath } from './paths.js';
import { loadConfig } from './config/index.js';
import { setupTestDb, teardownTestDb } from './test-helpers.js';
import { clearSkillDiscoveryCache } from './skills/loader.js';

function writeSkill(dir: string, content: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), content, 'utf-8');
}

describe('api skill detail routes', () => {
  const savedMoziHome = process.env.MOZI_HOME;
  const savedProjectRoot = process.env.MOZI_PROJECT_ROOT;
  let moziHome: string;
  let projectRoot: string;
  let dbTmpDir: string;

  beforeEach(() => {
    moziHome = mkdtempSync(join(tmpdir(), 'mozi-skills-home-'));
    projectRoot = mkdtempSync(join(tmpdir(), 'mozi-skills-project-'));
    process.env.MOZI_HOME = moziHome;
    process.env.MOZI_PROJECT_ROOT = projectRoot;
    loadConfig(getConfigPath());
    dbTmpDir = setupTestDb().tmpDir;
    clearSkillDiscoveryCache();

    writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({ name: 'mozi' }), 'utf-8');
    writeSkill(join(projectRoot, 'skills', 'docx'), `---
name: docx
description: Bundled DOCX skill
license: Complete terms in LICENSE.txt
version: "1.0.0"
category: utility
user-invocable: true
---

# DOCX

Bundled body.
`);
    mkdirSync(join(projectRoot, 'skills', 'docx', 'references'), { recursive: true });
    writeFileSync(join(projectRoot, 'skills', 'docx', 'references', 'guide.md'), 'reference', 'utf-8');

    writeSkill(join(moziHome, 'workspace', 'skills', 'workspace-skill'), `---
name: workspace-skill
description: Workspace skill
version: "1.0.0"
category: utility
user-invocable: true
---

# Workspace

Editable body.
`);
  });

  afterEach(() => {
    teardownTestDb(dbTmpDir);
    rmSync(moziHome, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
    if (savedMoziHome === undefined) {
      delete process.env.MOZI_HOME;
    } else {
      process.env.MOZI_HOME = savedMoziHome;
    }
    if (savedProjectRoot === undefined) {
      delete process.env.MOZI_PROJECT_ROOT;
    } else {
      process.env.MOZI_PROJECT_ROOT = savedProjectRoot;
    }
    clearSkillDiscoveryCache();
    loadConfig('/nonexistent/mozi.json');
  });

  async function makeApp() {
    const app = Fastify();
    await registerApiRoutes(app, {
      jwtSecret: 'test-secret',
      config: {
        server: { auth_mode: 'none', host: '127.0.0.1' },
        security: { enterprise: {} },
        http_rate_limit: { global_rpm: 100, auth_rpm: 10, pair_rpm: 5 },
      },
    });
    return app;
  }

  it('returns full skill detail for a bundled skill', async () => {
    const app = await makeApp();
    try {
      const response = await app.inject({ method: 'GET', url: '/api/skills/bundled:docx' });
      expect(response.statusCode).toBe(200);
      const payload = response.json() as {
        skill: {
          source: string;
          file_path: string;
          frontmatter: { name: string; license: string };
          content: string;
          files: Array<{ name: string; size: number }>;
        };
      };
      expect(payload.skill.source).toBe('bundled');
      expect(payload.skill.frontmatter).toMatchObject({
        name: 'docx',
        license: 'Complete terms in LICENSE.txt',
      });
      expect(payload.skill.content).toContain('Bundled body.');
      expect(payload.skill.file_path).toBe(realpathSync(join(projectRoot, 'skills', 'docx', 'SKILL.md')));
      expect(payload.skill.files).toEqual(expect.arrayContaining([
        { name: 'SKILL.md', size: expect.any(Number) },
        { name: 'references/guide.md', size: Buffer.byteLength('reference') },
      ]));
    } finally {
      await app.close();
    }
  });

  it('returns 404 for an unknown skill id', async () => {
    const app = await makeApp();
    try {
      const response = await app.inject({ method: 'GET', url: '/api/skills/bundled:missing-skill' });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ success: false });
    } finally {
      await app.close();
    }
  });

  it('rejects bundled skill updates as read-only', async () => {
    const app = await makeApp();
    try {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/skills/bundled:docx',
        payload: { content: readFileSync(join(projectRoot, 'skills', 'docx', 'SKILL.md'), 'utf-8') },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ success: false, error: 'Bundled skills are read-only' });
    } finally {
      await app.close();
    }
  });

  it('updates workspace skill content and rejects invalid frontmatter', async () => {
    const app = await makeApp();
    const skillPath = join(moziHome, 'workspace', 'skills', 'workspace-skill', 'SKILL.md');
    const updatedContent = `---
name: workspace-skill
description: Workspace skill updated
version: "1.0.1"
category: utility
user-invocable: true
---

# Workspace Updated

Edited body.
`;
    try {
      const updated = await app.inject({
        method: 'PUT',
        url: '/api/skills/workspace:workspace-skill',
        payload: { content: updatedContent },
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json()).toMatchObject({
        success: true,
        skill: {
          description: 'Workspace skill updated',
          content: updatedContent,
        },
      });
      expect(readFileSync(skillPath, 'utf-8')).toBe(updatedContent);

      const invalid = await app.inject({
        method: 'PUT',
        url: '/api/skills/workspace:workspace-skill',
        payload: { content: 'not valid skill content' },
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({
        success: false,
        error: expect.stringContaining('missing YAML frontmatter'),
      });
      expect(readFileSync(skillPath, 'utf-8')).toBe(updatedContent);
    } finally {
      await app.close();
    }
  });

  it('rejects path traversal skill ids', async () => {
    const app = await makeApp();
    try {
      const response = await app.inject({ method: 'GET', url: '/api/skills/bundled:%2E%2E%2Fdocx' });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ success: false });
    } finally {
      await app.close();
    }
  });

  it('updates workspace enabled state', async () => {
    const app = await makeApp();
    const disabledMarker = join(moziHome, 'workspace', 'skills', 'workspace-skill', '.disabled');
    try {
      const disabled = await app.inject({
        method: 'POST',
        url: '/api/skills/workspace:workspace-skill/state',
        payload: { enabled: false },
      });
      expect(disabled.statusCode).toBe(200);
      expect(disabled.json()).toMatchObject({ success: true, skill: { enabled: false } });
      expect(existsSync(disabledMarker)).toBe(true);
    } finally {
      await app.close();
    }
  });
});
