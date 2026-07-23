import type { LoadedSkill } from './loader.js';

// A skill activated via use_skill stays injected for this many subsequent user
// turns. 1 was too aggressive: multi-turn tasks silently lost the instructions
// on the second turn while the model still believed the skill was active. The
// Brain can end it earlier with unload_skill.
export const ACTIVE_SKILL_TTL_TURNS = 3;

export interface ActiveSkillEntry {
  name: string;
  description: string;
  instructions: string;
  loadedAtUserTurn: number;
}

export interface ActiveSkillScopeInput {
  tenantId?: string;
  sessionId?: string;
  chatId?: string;
}

interface ActiveSkillRegistry {
  currentUserTurn: number;
  skills: Map<string, ActiveSkillEntry>;
}

const registries = new Map<string, ActiveSkillRegistry>();

export function activeSkillScope(input: ActiveSkillScopeInput): string | null {
  const sessionKey = input.sessionId?.trim() || input.chatId?.trim();
  if (!sessionKey) return null;
  return `${input.tenantId?.trim() || 'default'}:${sessionKey}`;
}

function getOrCreateRegistry(scope: string): ActiveSkillRegistry {
  let registry = registries.get(scope);
  if (!registry) {
    registry = { currentUserTurn: 0, skills: new Map() };
    registries.set(scope, registry);
  }
  return registry;
}

function pruneExpired(registry: ActiveSkillRegistry): void {
  for (const [name, skill] of registry.skills) {
    if (registry.currentUserTurn - skill.loadedAtUserTurn > ACTIVE_SKILL_TTL_TURNS) {
      registry.skills.delete(name);
    }
  }
}

export function beginActiveSkillUserTurn(scope: string): ActiveSkillEntry[] {
  const registry = getOrCreateRegistry(scope);
  registry.currentUserTurn += 1;
  pruneExpired(registry);
  return getActiveSkills(scope);
}

export function activateSkill(scope: string, skill: LoadedSkill): ActiveSkillEntry {
  const registry = getOrCreateRegistry(scope);
  const entry: ActiveSkillEntry = {
    name: skill.name,
    description: skill.description,
    instructions: skill.instructions,
    loadedAtUserTurn: registry.currentUserTurn,
  };
  registry.skills.set(skill.name, entry);
  return entry;
}

export function unloadActiveSkill(scope: string, name: string): boolean {
  const registry = registries.get(scope);
  if (!registry) return false;
  return registry.skills.delete(name);
}

export function getActiveSkills(scope: string): ActiveSkillEntry[] {
  return Array.from(registries.get(scope)?.skills.values() ?? []);
}

export function clearActiveSkillsForTests(scope?: string): void {
  if (scope) {
    registries.delete(scope);
    return;
  }
  registries.clear();
}
