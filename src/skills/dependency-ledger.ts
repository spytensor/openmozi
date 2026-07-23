/**
 * Runtime dependency ledger for skill-declared capabilities.
 *
 * The Brain chooses workflows; the runtime owns dependency truth. When an
 * execution failure names an exact missing import, module, binary, or env key,
 * this module looks only at enabled SKILL.md declarations. It never guesses a
 * package name from error text. Provisionable pip/npm entries are installed by
 * the existing managed provisioner; system/manual requirements are surfaced as
 * explicit operator actions.
 */

import { join } from 'node:path';
import { getRuntimeProjectRoot } from '../runtime/project-root.js';
import { getWorkspaceDir } from '../tools/workspace-policy.js';
import type { ToolContext } from '../tools/types.js';
import { activateSkill, activeSkillScope } from './active-skills.js';
import {
  discoverSkills,
  type LoadedSkill,
  type SkillInstallSpec,
} from './loader.js';
import { provisionSkillDependencies } from './provision-deps.js';

export type DependencyFailureKind = 'python' | 'npm' | 'binary' | 'env';

export interface DependencyFailure {
  kind: DependencyFailureKind;
  name: string;
}

export interface DependencyRecovery {
  status: 'provisioned' | 'needs_action' | 'failed' | 'ambiguous';
  dependency: DependencyFailure;
  message: string;
  skill?: LoadedSkill;
}

interface DependencyCandidate {
  skill: LoadedSkill;
  spec?: SkillInstallSpec;
}

const SAFE_IMPORT = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const SAFE_NODE_MODULE = /^(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/;
const SAFE_BIN = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const SAFE_ENV = /^[A-Z_][A-Z0-9_]*$/;

function firstMatch(output: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = pattern.exec(output);
    const value = match?.[1]?.trim();
    if (value) return value;
  }
  return null;
}

export function extractDependencyFailure(output: string): DependencyFailure | null {
  const python = firstMatch(output, [
    /ModuleNotFoundError:\s*No module named\s+['"]([^'"]+)['"]/i,
    /ImportError:\s*No module named\s+['"]([^'"]+)['"]/i,
  ]);
  if (python) {
    const name = python.split('.')[0];
    if (SAFE_IMPORT.test(name)) return { kind: 'python', name };
  }

  const npm = firstMatch(output, [
    /Cannot find module\s+['"]([^'"]+)['"]/i,
    /Cannot find package\s+['"]([^'"]+)['"]/i,
    /ERR_MODULE_NOT_FOUND[^\n]*package\s+['"]([^'"]+)['"]/i,
  ]);
  if (npm && SAFE_NODE_MODULE.test(npm)) return { kind: 'npm', name: npm };

  const binary = firstMatch(output, [
    /command not found:\s*([A-Za-z0-9_.-]+)/i,
    /([A-Za-z0-9_.-]+):\s*command not found/i,
    /env:\s*([A-Za-z0-9_.-]+):\s*No such file or directory/i,
  ]);
  if (binary && SAFE_BIN.test(binary)) return { kind: 'binary', name: binary };

  const env = firstMatch(output, [
    /(?:environment variable|env(?:ironment)? var(?:iable)?)\s+['"]?([A-Z_][A-Z0-9_]*)['"]?\s+(?:is\s+)?(?:missing|not set|required)/i,
    /(?:missing|required)\s+(?:environment variable|env(?:ironment)? var(?:iable)?)\s+['"]?([A-Z_][A-Z0-9_]*)['"]?/i,
  ]);
  if (env && SAFE_ENV.test(env)) return { kind: 'env', name: env };

  return null;
}

function candidatesFor(skills: LoadedSkill[], failure: DependencyFailure): DependencyCandidate[] {
  const candidates: DependencyCandidate[] = [];
  for (const skill of skills) {
    if (!skill.enabled || skill.frontmatter['disable-model-invocation']) continue;
    if (failure.kind === 'env' && skill.frontmatter.requires?.env?.includes(failure.name)) {
      candidates.push({ skill });
    }
    if (
      failure.kind === 'binary'
      && (
        skill.frontmatter.requires?.bins?.includes(failure.name)
        || skill.frontmatter.requires?.anyBins?.includes(failure.name)
      )
    ) {
      candidates.push({ skill });
    }
    for (const spec of skill.frontmatter.install ?? []) {
      if (
        (failure.kind === 'python' || failure.kind === 'npm')
        && spec.imports?.includes(failure.name)
      ) {
        candidates.push({ skill, spec });
      } else if (failure.kind === 'binary' && spec.bins?.includes(failure.name)) {
        candidates.push({ skill, spec });
      }
    }
  }
  return candidates;
}

function actionFor(spec: SkillInstallSpec | undefined, failure: DependencyFailure): string {
  if (!spec) return `configure ${failure.kind} dependency ${failure.name}`;
  if (spec.kind === 'brew' && spec.formula) return `brew install ${spec.formula}`;
  if (spec.command) return spec.command;
  return spec.label || `install ${spec.formula || spec.package || failure.name}`;
}

function activateRecoveredSkill(skill: LoadedSkill, context?: ToolContext): void {
  if (!skill.eligible) return;
  const scope = activeSkillScope({
    tenantId: context?.tenantId,
    sessionId: context?.sessionId,
    chatId: context?.chatId,
  });
  if (scope) activateSkill(scope, skill);
}

/** Recover one exact, declared dependency failure. The caller should keep the
 * original tool result failed and ask the Brain to retry after provisioning;
 * this preserves truthful execution history. */
export async function recoverDeclaredSkillDependency(
  output: string,
  context?: ToolContext,
): Promise<DependencyRecovery | null> {
  const dependency = extractDependencyFailure(output);
  if (!dependency) return null;

  const skills = await discoverSkills({
    bundledDir: join(getRuntimeProjectRoot(), 'skills'),
    workspaceDir: join(getWorkspaceDir(), 'skills'),
  });
  const candidates = candidatesFor(skills, dependency);
  if (candidates.length === 0) return null;

  const uniqueSkills = [...new Set(candidates.map(candidate => candidate.skill.name))];
  const uniqueSpecs = [...new Set(candidates.map(candidate => {
    const spec = candidate.spec;
    return spec ? `${spec.kind}:${spec.package || spec.formula || spec.command || ''}` : 'requirement';
  }))];
  if (uniqueSpecs.length > 1) {
    return {
      status: 'ambiguous',
      dependency,
      message: `Dependency ${dependency.name} is declared by multiple skills (${uniqueSkills.join(', ')}). Activate the relevant skill before retrying; runtime did not guess.`,
    };
  }

  const candidate = candidates[0];
  const spec = candidate.spec;
  if (!spec || spec.kind === 'brew' || spec.kind === 'manual') {
    return {
      status: 'needs_action',
      dependency,
      skill: candidate.skill,
      message: `Skill ${candidate.skill.name} declares missing ${dependency.kind} dependency ${dependency.name}. Required action: ${actionFor(spec, dependency)}.`,
    };
  }

  const result = await provisionSkillDependencies([spec]);
  if (result.installed.length > 0 || result.ready.length > 0) {
    const singleOwner = uniqueSkills.length === 1 ? candidate.skill : undefined;
    if (singleOwner) activateRecoveredSkill(singleOwner, context);
    return {
      status: 'provisioned',
      dependency,
      ...(singleOwner ? { skill: singleOwner } : {}),
      message: `Runtime provisioned and verified ${dependency.name} from declared skill manifest${singleOwner ? ` ${singleOwner.name}` : `s (${uniqueSkills.join(', ')})`}. Retry the failed command; do not run pip/npm install manually.`,
    };
  }
  const failure = result.failed[0];
  return {
    status: 'failed',
    dependency,
    skill: candidate.skill,
    message: `Runtime could not provision ${dependency.name} from skill ${candidate.skill.name}: ${failure?.error || 'dependency did not become ready'}.`,
  };
}
