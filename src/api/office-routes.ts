import { createReadStream, type Stats } from 'node:fs';
import { basename, extname } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { mimeForFilePath } from '../artifacts/file-artifacts.js';
import {
  createNativeOfficeSession,
  resolveNativeOfficeEnvironment,
  verifyNativeOfficeFileToken,
} from '../artifacts/office-native.js';

type TenantContext = { tenant_id: string; user_id: string; roles: string[] };
type ResolvedFile = { path: string; stats: Stats };

export interface OfficeRouteDependencies {
  resolveAllowedFile(path: string, userId: string): ResolvedFile | null;
}

const OfficeSessionQuerySchema = z.object({
  path: z.string().min(1),
  locale: z.string().max(20).optional(),
}).strict();

const OfficeFileTokenQuerySchema = z.object({ token: z.string().min(1) }).strict();

function tenantContext(request: unknown): TenantContext | undefined {
  return (request as { tenantContext?: TenantContext }).tenantContext;
}

function asciiFallbackFilename(filename: string): string {
  return filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_') || 'file';
}

export function registerOfficeRoutes(app: FastifyInstance, deps: OfficeRouteDependencies): void {
  app.get('/api/office/session', async (request, reply) => {
    const context = tenantContext(request);
    if (!context) return reply.code(401).send({ success: false, error: 'Not authenticated' });
    const parsed = OfficeSessionQuerySchema.safeParse(request.query || {});
    if (!parsed.success) return reply.code(400).send({ success: false, error: parsed.error.message });
    const office = resolveNativeOfficeEnvironment();
    if (!office) return reply.code(503).send({ success: false, available: false, reason: 'not_configured' });
    const resolved = deps.resolveAllowedFile(parsed.data.path, context.user_id);
    if (!resolved) return reply.code(404).send({ success: false, available: false, reason: 'file_unavailable' });
    const extension = extname(resolved.path).replace(/^\./, '').toLowerCase();
    const session = createNativeOfficeSession({
      path: resolved.path,
      filename: basename(resolved.path),
      extension,
      size: resolved.stats.size,
      mtimeMs: resolved.stats.mtimeMs,
      tenantId: context.tenant_id,
      userId: context.user_id,
      locale: parsed.data.locale,
      env: office,
    });
    if (!session) return reply.code(415).send({ success: false, available: false, reason: 'unsupported_office_type' });
    return reply.send({ success: true, available: true, ...session });
  });

  // ONLYOFFICE fetches this URL server-to-server and cannot use browser auth.
  app.get('/api/office/file', async (request, reply) => {
    const parsed = OfficeFileTokenQuerySchema.safeParse(request.query || {});
    if (!parsed.success) return reply.code(400).send({ success: false, error: 'Invalid Office file token' });
    const office = resolveNativeOfficeEnvironment();
    if (!office) return reply.code(503).send({ success: false, error: 'Native Office service is not configured' });
    const claims = verifyNativeOfficeFileToken(parsed.data.token, office.jwtSecret);
    if (!claims) return reply.code(401).send({ success: false, error: 'Invalid or expired Office file token' });
    const resolved = deps.resolveAllowedFile(claims.path, claims.userId);
    if (!resolved) return reply.code(404).send({ success: false, error: 'File unavailable' });
    reply
      .type(mimeForFilePath(resolved.path))
      .header('Content-Disposition', `inline; filename="${asciiFallbackFilename(basename(resolved.path))}"`)
      .header('Content-Length', String(resolved.stats.size));
    return reply.send(createReadStream(resolved.path));
  });
}
