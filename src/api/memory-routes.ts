import type { FastifyInstance } from 'fastify';
import { getConfig } from '../config/index.js';
import { getAccessibleChatIdsForUser } from '../memory/conversations.js';
import { resolveMemoryEmbeddingProvider } from '../memory/embedding-provider.js';
import {
  deleteAllAccessibleFacts,
  deleteFactById,
  getAccessibleFacts,
  recallFacts,
  type FactCategory,
  type MemoryFactStatus,
  type MemoryAccessScope,
} from '../memory/long-term.js';
import { applyMemoryMutation, setMemoryFactStatus } from '../memory/mutations.js';
import { getRecentDigests } from '../memory/session-digest.js';
import { PROJECT_CHAT_ID, projectChatId } from '../memory/project-context.js';

type TenantContext = { tenant_id: string; user_id: string; roles: string[] };

function context(request: unknown): TenantContext | undefined {
  return (request as { tenantContext?: TenantContext }).tenantContext;
}

function memoryScope(tenant: TenantContext | undefined): MemoryAccessScope | undefined {
  if (!tenant?.user_id) return undefined;
  return {
    userId: tenant.user_id,
    accessibleChatIds: getAccessibleChatIdsForUser(tenant.user_id, tenant.tenant_id),
  };
}

function browseScope(tenant: TenantContext | undefined): MemoryAccessScope | undefined {
  const scope = memoryScope(tenant);
  if (!scope) return undefined;
  return {
    ...scope,
    accessibleChatIds: [...new Set([
      ...scope.accessibleChatIds,
      '__profile__',
      '__semantic__',
      ...(tenant?.roles.includes('admin') ? ['__project__'] : []),
    ])],
  };
}

export function registerMemoryRoutes(app: FastifyInstance): void {
  app.get('/api/memory/facts', async (request, reply) => {
    const query = request.query as { category?: string };
    const tenant = context(request);
    const facts = getAccessibleFacts(
      tenant?.tenant_id ?? 'default',
      browseScope(tenant),
      query.category as FactCategory | undefined,
      true,
    );
    return reply.send({ facts });
  });

  app.get('/api/memory/search', async (request, reply) => {
    const query = request.query as { q?: string; chatId?: string; limit?: string };
    if (!query.q) return reply.code(400).send({ error: 'Missing query parameter: q' });
    const tenant = context(request);
    const facts = await recallFacts(
      query.chatId || 'global',
      query.q,
      tenant?.tenant_id ?? 'default',
      query.limit ? parseInt(query.limit, 10) : 10,
      memoryScope(tenant),
    );
    return reply.send({ facts });
  });

  app.delete('/api/memory/facts/:id', async (request, reply) => {
    const numericId = parseInt((request.params as { id: string }).id, 10);
    if (Number.isNaN(numericId)) return reply.code(400).send({ error: 'Invalid fact ID' });
    const tenant = context(request);
    const deleted = deleteFactById(numericId, tenant?.tenant_id ?? 'default', browseScope(tenant));
    if (!deleted) return reply.code(404).send({ error: 'Fact not found' });
    return reply.send({ ok: true });
  });

  app.patch('/api/memory/facts/:id', async (request, reply) => {
    const numericId = parseInt((request.params as { id: string }).id, 10);
    if (Number.isNaN(numericId)) return reply.code(400).send({ error: 'Invalid fact ID' });
    const value = typeof (request.body as { value?: string })?.value === 'string'
      ? (request.body as { value: string }).value.trim()
      : '';
    if (!value) return reply.code(400).send({ error: 'Missing value' });
    const tenant = context(request);
    const tenantId = tenant?.tenant_id ?? 'default';
    const existing = getAccessibleFacts(tenantId, browseScope(tenant), undefined, true)
      .find(fact => fact.id === numericId);
    if (!existing) return reply.code(404).send({ error: 'Fact not found' });
    const mutation = applyMemoryMutation({
      chatId: existing.chat_id,
      tenantId,
      userId: tenant?.user_id,
      category: existing.category,
      key: existing.key,
      value,
      source: 'user_edit',
      requestedAction: 'UPDATE',
      targetFactId: existing.id,
      status: existing.status,
      originKind: existing.origin_kind,
      candidateScope: 'chat',
    });
    return reply.send({ fact: mutation.fact });
  });

  app.patch('/api/memory/facts/:id/status', async (request, reply) => {
    const numericId = parseInt((request.params as { id: string }).id, 10);
    if (Number.isNaN(numericId)) return reply.code(400).send({ error: 'Invalid fact ID' });
    const rawStatus = (request.body as { status?: string })?.status;
    const allowedStatuses: MemoryFactStatus[] = ['active', 'disputed', 'retracted'];
    if (!allowedStatuses.includes(rawStatus as MemoryFactStatus)) {
      return reply.code(400).send({ error: 'Invalid memory status' });
    }
    const tenant = context(request);
    const tenantId = tenant?.tenant_id ?? 'default';
    const scope = browseScope(tenant);
    const existing = getAccessibleFacts(tenantId, scope, undefined, true).find(fact => fact.id === numericId);
    if (!existing) return reply.code(404).send({ error: 'Fact not found' });
    const promotion = rawStatus === 'active' && existing.chat_id === PROJECT_CHAT_ID && tenant?.user_id
      ? { chatId: projectChatId(tenant.user_id), userId: tenant.user_id }
      : undefined;
    if (promotion) {
      const collision = getAccessibleFacts(tenantId, scope, existing.category, true).some(fact => (
        fact.id !== existing.id
        && fact.chat_id === promotion.chatId
        && fact.key === existing.key
      ));
      if (collision) return reply.code(409).send({ error: 'An active project memory already uses this key' });
    }
    const fact = setMemoryFactStatus(numericId, rawStatus as MemoryFactStatus, {
      chatId: existing.chat_id,
      tenantId,
      userId: tenant?.user_id,
      source: 'user_review',
    }, scope, promotion);
    if (!fact) return reply.code(404).send({ error: 'Fact not found' });
    return reply.send({ fact });
  });

  app.post('/api/memory/facts', async (request, reply) => {
    const body = request.body as { category?: string; value?: string; key?: string };
    const validCategories = ['preference', 'fact', 'decision', 'lesson'] as const;
    const category = validCategories.includes(body?.category as never) ? body.category as FactCategory : null;
    const value = typeof body?.value === 'string' ? body.value.trim() : '';
    if (!category) return reply.code(400).send({ error: 'Invalid category' });
    if (!value) return reply.code(400).send({ error: 'Missing value' });
    const tenant = context(request);
    const tenantId = tenant?.tenant_id ?? 'default';
    const userId = tenant?.user_id;
    const chatId = userId ?? 'global';
    const key = typeof body?.key === 'string' && body.key.trim()
      ? body.key.trim()
      : `manual_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const mutation = applyMemoryMutation({
      chatId,
      category,
      key,
      value,
      source: 'manual',
      tenantId,
      userId,
      salienceHint: 0.7,
      requestedAction: 'AUTO',
    });
    return reply.code(mutation.action === 'ADD' ? 201 : 200).send(mutation);
  });

  app.get('/api/memory/status', async (request, reply) => {
    const config = getConfig();
    const tenant = context(request);
    const tenantId = tenant?.tenant_id ?? 'default';
    const resolution = resolveMemoryEmbeddingProvider(config, process.env, tenantId);
    const factCount = getAccessibleFacts(tenantId, browseScope(tenant)).length;
    const semanticActive = resolution.provider !== null
      && factCount >= config.memory.semantic_activation_threshold;
    return reply.send({
      recall_strategy: config.memory.recall_strategy,
      search_mode: semanticActive ? 'semantic_hybrid' : 'local_fts',
      semantic_enabled: semanticActive,
      semantic_available: resolution.provider !== null,
      embedding_provider: resolution.provider?.providerName ?? null,
      embedding_model: resolution.provider?.modelName ?? null,
      activation_threshold: config.memory.semantic_activation_threshold,
      fact_count: factCount,
      reason: semanticActive
        ? resolution.reason
        : resolution.provider
          ? 'below_semantic_activation_threshold'
          : resolution.reason,
    });
  });

  app.get('/api/memory/export', async (request, reply) => {
    const tenant = context(request);
    const tenantId = tenant?.tenant_id ?? 'default';
    const facts = getAccessibleFacts(tenantId, browseScope(tenant), undefined, true);
    reply.header('Content-Disposition', 'attachment; filename="mozi-memory.json"');
    return reply.send({ exported_at: new Date().toISOString(), tenant_id: tenantId, count: facts.length, facts });
  });

  app.delete('/api/memory/facts', async (request, reply) => {
    const tenant = context(request);
    const deleted = deleteAllAccessibleFacts(tenant?.tenant_id ?? 'default', memoryScope(tenant));
    return reply.send({ ok: true, deleted });
  });

  app.get('/api/memory/digests', async (request, reply) => {
    const tenant = context(request);
    if (!tenant?.user_id) return reply.send({ digests: [] });
    return reply.send({ digests: getRecentDigests(tenant.user_id, tenant.tenant_id, 30, 20) });
  });
}
