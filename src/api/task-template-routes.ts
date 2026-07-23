import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createTaskTemplate,
  deleteTaskTemplate,
  getTaskTemplate,
  listTaskTemplates,
  reorderTaskTemplates,
  updateTaskTemplate,
} from '../task-templates/store.js';

type TenantContext = { tenant_id: string; user_id: string; roles: string[] };

const TemplateBodySchema = z.object({
  title: z.string().trim().min(1).max(80),
  instructions: z.string().trim().min(1).max(8_000),
  output_format: z.string().trim().max(4_000).optional().default(''),
  pinned: z.boolean().optional().default(true),
}).strict();

const ReorderBodySchema = z.object({
  ids: z.array(z.string().uuid()).max(500),
}).strict();

function context(request: unknown): TenantContext | undefined {
  return (request as { tenantContext?: TenantContext }).tenantContext;
}

export function registerTaskTemplateRoutes(app: FastifyInstance): void {
  app.get('/api/task-templates', async (request, reply) => {
    const ctx = context(request);
    if (!ctx) return reply.code(401).send({ error: 'Authentication required' });
    return reply.send({ templates: listTaskTemplates(ctx.tenant_id, ctx.user_id) });
  });

  app.post('/api/task-templates', async (request, reply) => {
    const ctx = context(request);
    if (!ctx) return reply.code(401).send({ error: 'Authentication required' });
    const parsed = TemplateBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid task template', details: parsed.error.flatten() });
    return reply.code(201).send({ template: createTaskTemplate(ctx.tenant_id, ctx.user_id, parsed.data) });
  });

  app.put('/api/task-templates/reorder', async (request, reply) => {
    const ctx = context(request);
    if (!ctx) return reply.code(401).send({ error: 'Authentication required' });
    const parsed = ReorderBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid task template order' });
    const templates = reorderTaskTemplates(ctx.tenant_id, ctx.user_id, parsed.data.ids);
    if (!templates) return reply.code(404).send({ error: 'Task template not found' });
    return reply.send({ templates });
  });

  app.get('/api/task-templates/:id', async (request, reply) => {
    const ctx = context(request);
    if (!ctx) return reply.code(401).send({ error: 'Authentication required' });
    const { id } = request.params as { id: string };
    const template = getTaskTemplate(ctx.tenant_id, ctx.user_id, id);
    return template ? reply.send({ template }) : reply.code(404).send({ error: 'Task template not found' });
  });

  app.put('/api/task-templates/:id', async (request, reply) => {
    const ctx = context(request);
    if (!ctx) return reply.code(401).send({ error: 'Authentication required' });
    const parsed = TemplateBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid task template', details: parsed.error.flatten() });
    const { id } = request.params as { id: string };
    const template = updateTaskTemplate(ctx.tenant_id, ctx.user_id, id, parsed.data);
    return template ? reply.send({ template }) : reply.code(404).send({ error: 'Task template not found' });
  });

  app.delete('/api/task-templates/:id', async (request, reply) => {
    const ctx = context(request);
    if (!ctx) return reply.code(401).send({ error: 'Authentication required' });
    const { id } = request.params as { id: string };
    return deleteTaskTemplate(ctx.tenant_id, ctx.user_id, id)
      ? reply.send({ ok: true })
      : reply.code(404).send({ error: 'Task template not found' });
  });
}
