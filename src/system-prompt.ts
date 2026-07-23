/**
 * System Prompt Loader — assembles the multi-layer system prompt.
 *
 * Extracted from index.ts. Pure functions with no side effects beyond file reads.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  buildRuntimeCapabilityManifest,
  formatCapabilitySummarySection,
} from './core/capability-manifest.js';
import type { MoziConfig } from './config/index.js';
import { getAllRegisteredTools } from './tools/dynamic-registry.js';
import { getRuntimeProjectRoot } from './runtime/project-root.js';
import { getDefaultOutputDir } from './paths.js';
import { formatAvailableToolsSection } from './prompt-sections.js';

/**
 * Resolve the workspace directory from config, expanding ~ to home.
 */
export function resolveWorkspaceDir(config: { workspace: { dir: string } }): string {
  const dir = config.workspace.dir;
  if (dir.startsWith('~/') || dir === '~') {
    return resolve(homedir(), dir.slice(2) || '.');
  }
  return resolve(dir);
}

export function resolveOutputDir(): string {
  return resolve(getDefaultOutputDir());
}

export function resolveTenantId(tenantId?: string): string {
  return tenantId ?? process.env.MOZI_TENANT_ID ?? 'default';
}

export function loadSystemPrompt(
  config: MoziConfig,
  tenantId?: string,
): string {
  return loadSystemPromptLayers(config, tenantId, true);
}

/**
 * Stable identity/runtime contract for DAG children. USER.md is deliberately
 * excluded: it is private user-profile context for the Brain, not an execution
 * instruction for delegated workers. SOUL/AGENTS local overrides remain part
 * of the owner's execution policy.
 */
export function loadDelegationSystemPrompt(
  config: MoziConfig,
  tenantId?: string,
): string {
  return loadSystemPromptLayers(config, tenantId, false);
}

function loadSystemPromptLayers(
  config: MoziConfig,
  tenantId: string | undefined,
  includeUserProfile: boolean,
): string {
  const workspaceDir = resolveWorkspaceDir(config);
  const outputDir = resolveOutputDir();
  const parts: string[] = [];
  const runtimeRoot = getRuntimeProjectRoot();

  // --- Layer 1: System templates (from dist/templates, auto-updated with each release) ---
  const systemTemplatesDir = join(dirname(fileURLToPath(import.meta.url)), 'templates');
  for (const file of ['SOUL.md', 'AGENTS.md']) {
    const sysPath = join(systemTemplatesDir, file);
    if (existsSync(sysPath)) {
      parts.push(readFileSync(sysPath, 'utf-8'));
    }
  }

  // --- Layer 2: User overrides (from workspace, never touched by upgrades) ---
  const userOverrideFiles = includeUserProfile
    ? ['SOUL.local.md', 'AGENTS.local.md', 'USER.md']
    : ['SOUL.local.md', 'AGENTS.local.md'];
  for (const file of userOverrideFiles) {
    const userPath = join(workspaceDir, file);
    if (existsSync(userPath)) {
      parts.push(readFileSync(userPath, 'utf-8'));
    }
  }

  if (parts.length === 0) {
    parts.push('You are a local agent runtime assistant. Be concise, direct, and helpful. Reply in the language of the user\'s current message unless they explicitly request a different response language.');
  }

  // Product-boundary and language rules are owned by SOUL.md (## Product
  // Boundary, ## Personality) — do not restate them here; duplicated policy
  // sections drift into contradictions and dilute instruction following.

  parts.push([
    '## Runtime File Context',
    '',
    `- outputDir: ${outputDir}`,
    `- workspaceDir: ${workspaceDir}`,
    '- outputDir is the deliverable shelf: put the files the user asked for (reports, decks, sheets, final images) there — only shelf files surface automatically as downloadable cards. Working material (downloaded datasets, intermediate charts, scratch notes) belongs under workspaceDir and stays out of the conversation.',
    '- In final replies, refer to produced files by name; do not print absolute filesystem paths.',
    '- File access roots are a logical Node policy; do not claim OS-level sandbox isolation from this alone.',
  ].join('\n'));

  // Replace path placeholders with actual runtime values
  const projectRoot = getRuntimeProjectRoot();
  for (let i = 0; i < parts.length; i++) {
    parts[i] = parts[i]
      .replace(/\{\{PROJECT_ROOT\}\}/g, projectRoot)
      .replace(/\{\{WORKSPACE_DIR\}\}/g, workspaceDir)
      .replace(/\{\{OUTPUT_DIR\}\}/g, outputDir);
  }

  // Append available tools section (compact, no markdown list for Telegram)
  const effectiveTenantId = resolveTenantId(tenantId);
  const availableTools = getAllRegisteredTools(effectiveTenantId);
  if (availableTools.length > 0) {
    const toolNames = availableTools.map(t => t.function.name).join(', ');
    parts.push(formatAvailableToolsSection(toolNames));
  } else {
    parts.push('## Mode\n\nConversation-only mode.');
  }

  // Compact capability summary only — the full per-capability contract is
  // available on demand via the get_capabilities tool. Injecting the full
  // manifest every turn cost 2-5K tokens to serve rare "is X enabled?" turns.
  const runtimeManifest = buildRuntimeCapabilityManifest(
    config,
    availableTools.map(t => t.function.name),
    effectiveTenantId,
  );
  parts.push(formatCapabilitySummarySection(runtimeManifest));

  return parts.join('\n\n---\n\n');
}

export function adaptPromptForChannel(
  basePrompt: string,
  channelType: string,
): string {
  if (channelType === 'wechat') {
    return [
      basePrompt,
      '---',
      'Channel Output Contract (WeChat):',
      '- Plain text only — WeChat does NOT render markdown.',
      '- Do NOT use markdown formatting (bold, italic, headings, tables, code blocks).',
      '- Use simple line breaks and indentation for structure.',
      '- Keep messages under 2000 characters. Split long responses naturally.',
      '- Use Chinese when the user writes in Chinese.',
    ].join('\n');
  }
  if (channelType !== 'telegram') return basePrompt;
  return [
    basePrompt,
    '---',
    'Channel Output Contract (Telegram):',
    '- You may use **bold**, *italic*, `inline code`, and ```code blocks``` — they will be rendered.',
    '- Do NOT use markdown tables (| col | col |) — Telegram cannot render them. Use simple "- label: value" lists instead.',
    '- Do NOT use ### headings — use **bold text** on its own line instead.',
    '- Do NOT use horizontal rules (---).',
    '- Keep messages concise and readable in Telegram chat bubbles.',
    '- Streaming is append-only: once text is visible to the user it will not be retracted or rewritten. Correct mistakes with a follow-up message, never by assuming message mutation.',
    '- Only user-facing rich artifacts (images, PDFs, media) are auto-sent. Intermediate markdown/code drafts and working files are not pushed unless explicitly requested.',
  ].join('\n');
}
