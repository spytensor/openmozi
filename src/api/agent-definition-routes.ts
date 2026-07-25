import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { PERMISSION_LEVELS } from '../security/permissions.js';
import {
  AgentDefinitionError,
  createAgentDefinition,
  deleteAgentDefinition,
  discoverAgentDefinitions,
  getAgentDefinition,
  setAgentDefinitionState,
  updateAgentDefinition,
  type AgentDefinitionInput,
  type AgentDefinitionPaths,
  type LoadedAgentDefinition,
} from '../agents/definition-loader.js';

const AgentBodySchema = z.object({
  name: z.string().trim().min(1).max(64),
  description: z.string().trim().min(1),
  persona: z.string(),
  model: z.string().trim().min(1).optional(),
  skills: z.array(z.string().trim().min(1)).default([]),
  tools: z.array(z.string().trim().min(1)).optional(),
  permission_level: z.enum(PERMISSION_LEVELS).optional(),
  color: z.string().trim().min(1).optional(),
}).strict();
const AgentStateSchema = z.object({ enabled: z.boolean() }).strict();

function summary(agent: LoadedAgentDefinition) {
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    model: agent.model ?? null,
    skills: agent.skills,
    color: agent.color ?? null,
    source: agent.source,
    status: agent.status,
    enabled: agent.enabled,
    missing_skills: agent.missingSkills,
    invalid_model: agent.invalidModel ?? null,
  };
}

function detail(agent: LoadedAgentDefinition) {
  return {
    ...summary(agent),
    tools: agent.tools ?? [],
    permission_level: agent.permission_level ?? null,
    persona: agent.persona,
    content: agent.content,
  };
}

function errorReply(reply: FastifyReply, error: unknown) {
  if (error instanceof AgentDefinitionError) {
    const status = error.code === 'not_found' ? 404
      : error.code === 'read_only' ? 403
      : error.code === 'conflict' ? 409
      : 400;
    return reply.code(status).send({ success: false, error: error.message });
  }
  throw error;
}

/** Register the file-backed /api/agents management routes. */
export function registerAgentDefinitionRoutes(app: FastifyInstance, paths: AgentDefinitionPaths = {}): void {
  app.get('/api/agents', async (_request, reply) => {
    const agents = await discoverAgentDefinitions(paths);
    return reply.send({ agents: agents.map(summary) });
  });

  app.get('/api/agents/:id', async (request, reply) => {
    try {
      const agent = await getAgentDefinition((request.params as { id: string }).id, paths);
      return reply.send({ agent: detail(agent) });
    } catch (error) {
      return errorReply(reply, error);
    }
  });

  app.post('/api/agents', async (request, reply) => {
    const parsed = AgentBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ success: false, error: parsed.error.issues[0]?.message });
    try {
      const agent = await createAgentDefinition(parsed.data as AgentDefinitionInput, paths);
      return reply.code(201).send({ success: true, agent: detail(agent) });
    } catch (error) {
      return errorReply(reply, error);
    }
  });

  app.put('/api/agents/:id', async (request, reply) => {
    const parsed = AgentBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ success: false, error: parsed.error.issues[0]?.message });
    try {
      const agent = await updateAgentDefinition((request.params as { id: string }).id, parsed.data as AgentDefinitionInput, paths);
      return reply.send({ success: true, agent: detail(agent) });
    } catch (error) {
      return errorReply(reply, error);
    }
  });

  app.post('/api/agents/:id/state', async (request, reply) => {
    const parsed = AgentStateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ success: false, error: parsed.error.issues[0]?.message });
    try {
      const agent = await setAgentDefinitionState((request.params as { id: string }).id, parsed.data.enabled, paths);
      return reply.send({ success: true, agent: detail(agent) });
    } catch (error) {
      return errorReply(reply, error);
    }
  });

  app.delete('/api/agents/:id', async (request, reply) => {
    try {
      await deleteAgentDefinition((request.params as { id: string }).id, paths);
      return reply.send({ success: true });
    } catch (error) {
      return errorReply(reply, error);
    }
  });
}
