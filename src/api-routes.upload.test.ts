import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { registerApiRoutes, sanitizeUploadFilename } from './api-routes.js';
import { getConfigPath } from './paths.js';
import { loadConfig } from './config/index.js';
import { setupTestDb, teardownTestDb } from './test-helpers.js';
import { ensureToolWorkspaceDir, getOutputDir } from './tools/workspace-policy.js';
import { assertFsPathAllowed } from './tools/tool-utils.js';
import { executeFsTool } from './tools/fs-tools.js';

type UploadResponse = Array<{
  filename: string;
  path: string;
  size: number;
  mimeType: string;
}>;

function multipartBody(boundary: string, filename: string, mimeType: string, content: string): string {
  return [
    `--${boundary}`,
    `Content-Disposition: form-data; name="files"; filename="${filename}"`,
    `Content-Type: ${mimeType}`,
    '',
    content,
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

function multipartBodyWithDir(boundary: string, dir: string, filename: string, mimeType: string, content: string): string {
  return [
    `--${boundary}`,
    'Content-Disposition: form-data; name="dir"',
    '',
    dir,
    `--${boundary}`,
    `Content-Disposition: form-data; name="files"; filename="${filename}"`,
    `Content-Type: ${mimeType}`,
    '',
    content,
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

describe('api upload route', () => {
  const savedMoziHome = process.env.MOZI_HOME;
  let moziHome: string;
  let dbTmpDir: string;

  beforeEach(() => {
    moziHome = mkdtempSync(join(tmpdir(), 'mozi-upload-home-'));
    process.env.MOZI_HOME = moziHome;
    loadConfig(getConfigPath());
    dbTmpDir = setupTestDb().tmpDir;
  });

  it('preserves Unicode filenames while removing path and control characters', () => {
    expect(sanitizeUploadFilename('../2026年Q2 税务动态.pdf')).toBe('2026年Q2 税务动态.pdf');
    expect(sanitizeUploadFilename('..\\季度报告：最终版?.xlsx')).toBe('季度报告：最终版_.xlsx');
    expect(sanitizeUploadFilename('报告\0\n最终版.docx')).toBe('报告最终版.docx');
    const longChineseName = sanitizeUploadFilename(`${'税'.repeat(100)}.pdf`);
    expect(Buffer.byteLength(longChineseName, 'utf8')).toBeLessThanOrEqual(180);
    expect(longChineseName.endsWith('.pdf')).toBe(true);
  });

  afterEach(() => {
    teardownTestDb(dbTmpDir);
    rmSync(moziHome, { recursive: true, force: true });
    if (savedMoziHome === undefined) {
      delete process.env.MOZI_HOME;
    } else {
      process.env.MOZI_HOME = savedMoziHome;
    }
    loadConfig('/nonexistent/mozi.json');
  });

  it('stores uploads in the tool workspace and returns a read_file-reachable absolute path', async () => {
    const app = Fastify();
    try {
      await registerApiRoutes(app, {
        jwtSecret: 'test-secret',
        config: {
          server: { auth_mode: 'none', host: '127.0.0.1' },
          security: { enterprise: {} },
          http_rate_limit: { global_rpm: 100, auth_rpm: 10, pair_rpm: 5 },
        },
      });

      const boundary = '----mozi-upload-test';
      const fileContent = 'name,value\nalpha,1\n';
      const response = await app.inject({
        method: 'POST',
        url: '/upload',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: multipartBody(boundary, '../report.csv', 'text/csv', fileContent),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as UploadResponse;
      expect(body).toHaveLength(1);

      const uploaded = body[0];
      const workspaceDir = await ensureToolWorkspaceDir('local-user');
      expect(uploaded.filename).toBe('report.csv');
      expect(uploaded.mimeType).toBe('text/csv');
      expect(uploaded.path.startsWith(workspaceDir)).toBe(true);
      expect(existsSync(uploaded.path)).toBe(true);
      expect(readFileSync(uploaded.path, 'utf8')).toBe(fileContent);
      expect(() => assertFsPathAllowed(uploaded.path, uploaded.path, 'local-user')).not.toThrow();

      const readResult = await executeFsTool(
        'read_file',
        { path: uploaded.path },
        'read-upload',
        { tenantId: 'default', userId: 'local-user', chatId: 'upload-test' },
      );
      expect(readResult?.is_error).toBe(false);
      expect(readResult?.content).toContain('alpha,1');
      expect(readResult?.file_path).toBe(uploaded.path);
    } finally {
      await app.close();
    }
  });

  it('stores uploads in a validated requested directory', async () => {
    const app = Fastify();
    try {
      await registerApiRoutes(app, {
        jwtSecret: 'test-secret',
        config: {
          server: { auth_mode: 'none', host: '127.0.0.1' },
          security: { enterprise: {} },
          http_rate_limit: { global_rpm: 100, auth_rpm: 10, pair_rpm: 5 },
        },
      });

      const workspaceDir = await ensureToolWorkspaceDir('local-user');
      const projectDir = join(workspaceDir, 'projects', 'alpha');
      mkdirSync(projectDir, { recursive: true });

      const boundary = '----mozi-upload-dir-test';
      const fileContent = '# Notes\n';
      const response = await app.inject({
        method: 'POST',
        url: `/upload?dir=${encodeURIComponent(workspaceDir)}`,
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: multipartBodyWithDir(boundary, projectDir, 'notes.md', 'text/markdown', fileContent),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as UploadResponse;
      expect(body).toHaveLength(1);
      expect(body[0].filename).toBe('notes.md');
      expect(realpathSync(dirname(body[0].path))).toBe(realpathSync(projectDir));
      expect(readFileSync(body[0].path, 'utf8')).toBe(fileContent);

      const fallback = await app.inject({
        method: 'POST',
        url: `/upload?dir=${encodeURIComponent(join(tmpdir(), 'not-allowed'))}`,
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: multipartBody(boundary, 'outside.md', 'text/markdown', fileContent),
      });
      expect(fallback.statusCode).toBe(200);
      const fallbackBody = fallback.json() as UploadResponse;
      expect(fallbackBody).toHaveLength(1);
      expect(fallbackBody[0].filename).toBe('outside.md');
      expect(fallbackBody[0].path.startsWith(workspaceDir)).toBe(true);
      expect(fallbackBody[0].path.startsWith(projectDir)).toBe(false);
      expect(readFileSync(fallbackBody[0].path, 'utf8')).toBe(fileContent);
    } finally {
      await app.close();
    }
  });

  it('rejects uploads into generated output instead of turning it into an inbox', async () => {
    const app = Fastify();
    try {
      await registerApiRoutes(app, {
        jwtSecret: 'test-secret',
        config: {
          server: { auth_mode: 'none', host: '127.0.0.1' },
          security: { enterprise: {} },
          http_rate_limit: { global_rpm: 100, auth_rpm: 10, pair_rpm: 5 },
        },
      });

      const outputDir = getOutputDir();
      const boundary = '----mozi-upload-output-test';
      const response = await app.inject({
        method: 'POST',
        url: `/upload?dir=${encodeURIComponent(outputDir)}`,
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: multipartBody(boundary, 'external-report.pdf', 'application/pdf', '%PDF-1.4\nexternal'),
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        success: false,
        code: 'generated_output_only',
      });
      expect(existsSync(join(outputDir, 'external-report.pdf'))).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('accepts archives, web pages, code, notebooks, and config formats (operator decision 2026-07-18)', async () => {
    const app = Fastify();
    try {
      await registerApiRoutes(app, {
        jwtSecret: 'test-secret',
        config: {
          server: { auth_mode: 'none', host: '127.0.0.1' },
          security: { enterprise: {} },
          http_rate_limit: { global_rpm: 100, auth_rpm: 10, pair_rpm: 5 },
        },
      });

      const cases: Array<[string, string]> = [
        ['dataset.zip', 'application/zip'],
        ['dump.tar.gz', 'application/octet-stream'],
        ['page.html', 'text/html'],
        ['script.py', 'application/octet-stream'],
        ['analysis.ipynb', 'application/octet-stream'],
        ['server.ts', 'application/octet-stream'],
        ['config.yaml', 'application/octet-stream'],
        ['schema.sql', 'application/octet-stream'],
        ['Dockerfile', 'application/octet-stream'],
        ['data.parquet', 'application/octet-stream'],
      ];
      for (const [filename, mime] of cases) {
        const boundary = '----mozi-upload-fmt';
        const response = await app.inject({
          method: 'POST',
          url: '/upload',
          headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
          payload: multipartBody(boundary, filename, mime, 'content-bytes'),
        });
        expect(response.statusCode, `${filename} (${mime}) should be accepted`).toBe(200);
      }
    } finally {
      await app.close();
    }
  });

  it('still rejects native executable material', async () => {
    const app = Fastify();
    try {
      await registerApiRoutes(app, {
        jwtSecret: 'test-secret',
        config: {
          server: { auth_mode: 'none', host: '127.0.0.1' },
          security: { enterprise: {} },
          http_rate_limit: { global_rpm: 100, auth_rpm: 10, pair_rpm: 5 },
        },
      });

      const cases: Array<[string, string]> = [
        ['tool.exe', 'application/octet-stream'],
        ['installer.dmg', 'application/octet-stream'],
        ['lib.dylib', 'application/octet-stream'],
        ['unnamed-binary', 'application/octet-stream'],
        ['app.msi', 'application/x-msdownload'],
      ];
      for (const [filename, mime] of cases) {
        const boundary = '----mozi-upload-rej';
        const response = await app.inject({
          method: 'POST',
          url: '/upload',
          headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
          payload: multipartBody(boundary, filename, mime, 'MZbinary'),
        });
        expect(response.statusCode, `${filename} (${mime}) must stay rejected`).toBe(415);
      }
    } finally {
      await app.close();
    }
  });
});

