import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../core/running-summary.js', () => ({
  compress: vi.fn(async () => ({
    summary: 'Deterministic conversation summary for context assembly tests.',
    kept_turns: [],
    key_facts: ['Context assembly remains deterministic in unit tests.'],
    summary_tokens: 16,
  })),
  mergeSummaries: vi.fn(async (existingSummary: string, newSummary: string) =>
    [existingSummary, newSummary].filter(Boolean).join('\n'),
  ),
}));
import {
  buildIntelligentContext,
  compileIntelligentContext,
  markHistoricalPhotoAnalysis,
  sanitizeStaleAttachmentPaths,
} from './context-builder.js';
import { saveFact, getFacts, recordRecall } from './long-term.js';
import { getDb } from '../store/db.js';
import { saveProjectFact } from './project-context.js';
import { saveLesson, resetPruneTimestamp } from './lessons.js';
import { saveMessage } from './conversations.js';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import { encodeArtifactMarker } from '../artifacts/marker.js';
import { getConfig, updateConfig } from '../config/index.js';
import {
  resetMemoryEmbeddingProviderForTests,
  setMemoryEmbeddingProviderForTests,
} from './embedding-provider.js';
import {
  ACTIVE_SKILL_TTL_TURNS,
  activateSkill,
  activeSkillScope,
  beginActiveSkillUserTurn,
  clearActiveSkillsForTests,
  getActiveSkills,
} from '../skills/active-skills.js';
import type { LoadedSkill } from '../skills/loader.js';
import { createSession } from './sessions.js';
import { saveTimelineItem } from './session-timeline.js';
import { getWorkspaceDir } from '../tools/workspace-policy.js';

let tmpDir: string;
let previousMoziWorkspaces: string | undefined;

function systemText(messages: Array<{ role: string; content: string }>): string {
  return messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
}

function turnSystemText(messages: Array<{ role: string; content: string }>): string {
  return [...messages].reverse().find(message => message.role === 'system')?.content ?? '';
}

beforeAll(() => {
  const result = setupTestDb();
  tmpDir = result.tmpDir;
  previousMoziWorkspaces = process.env.MOZI_WORKSPACES;
  process.env.MOZI_WORKSPACES = join(tmpDir, 'user-workspaces');
});

beforeEach(() => {
  setMemoryEmbeddingProviderForTests(null);
});

afterEach(() => {
  resetMemoryEmbeddingProviderForTests();
  clearActiveSkillsForTests();
});

afterAll(() => {
  if (previousMoziWorkspaces === undefined) delete process.env.MOZI_WORKSPACES;
  else process.env.MOZI_WORKSPACES = previousMoziWorkspaces;
  teardownTestDb(tmpDir);
});

describe('memory/context-builder', () => {
  it('injects relevant facts (preferences always, lessons by overlap) and preserves ordering', async () => {
    const chatId = 'ctx_relevance_order';
    saveFact(chatId, 'preference', 'language', 'TypeScript');
    saveFact(chatId, 'fact', 'city', 'Seattle');
    saveFact(chatId, 'decision', 'runtime', 'Bun');
    saveLesson('typescript', 'Use strict mode when possible');

    saveMessage(chatId, 'user', 'previous user message');
    saveMessage(chatId, 'assistant', 'previous assistant message');

    const context = await buildIntelligentContext(
      chatId,
      'You are helpful.',
      'Help me with TypeScript project setup.',
    );

    expect(context[0].role).toBe('system');
    expect(context[0].content).toContain('You are helpful.');
    expect(context[0].content).toContain('## What I Remember');
    expect(context[0].content).toContain('language: TypeScript');
    // 'fact' category is now always included (user basic facts)
    expect(context[0].content).toContain('city: Seattle');
    // 'decision' category requires token overlap — 'runtime: Bun' has no overlap
    // with 'Help me with TypeScript project setup.'
    expect(context[0].content).not.toContain('runtime: Bun');
    expect(systemText(context)).toContain('## Lessons Learned');
    expect(systemText(context)).toContain('Use strict mode when possible');

    expect(context.some(m => m.role === 'user' && m.content === 'previous user message')).toBe(true);
    expect(context.some(m => m.role === 'assistant' && m.content === 'previous assistant message')).toBe(true);
    expect(context[context.length - 1]).toEqual({
      role: 'user',
      content: 'Help me with TypeScript project setup.',
    });
  });

  it('limits remembered facts to at most 20 relevant entries', async () => {
    const chatId = 'ctx_fact_limit';
    for (let i = 0; i < 25; i++) {
      saveFact(chatId, 'fact', `typescript_note_${i}`, `TypeScript detail ${i}`);
    }

    const context = await buildIntelligentContext(
      chatId,
      'sys',
      'Need TypeScript migration advice',
    );

    const factCount = (context[0].content.match(/- \[fact\]/g) ?? []).length;
    expect(factCount).toBe(20);
  });

  it('matches Chinese facts when user message contains CJK characters', async () => {
    const chatId = 'ctx_cjk_match';
    saveFact(chatId, 'preference', '编程语言', 'TypeScript');
    saveFact(chatId, 'fact', '城市', '北京');
    saveFact(chatId, 'decision', 'database', 'PostgreSQL');

    const context = await buildIntelligentContext(
      chatId,
      'You are helpful.',
      '帮我分析北京的数据',
    );

    expect(context[0].content).toContain('## What I Remember');
    // preference and fact categories are always included
    expect(context[0].content).toContain('编程语言: TypeScript');
    expect(context[0].content).toContain('城市: 北京');
    // 'decision' with no CJK overlap → not included
    expect(context[0].content).not.toContain('database: PostgreSQL');
  });

  it('does not select a Chinese decision through a shared single Han character', async () => {
    const chatId = 'ctx_cjk_single_han_noise';
    saveFact(chatId, 'decision', '报告归档', '保存季度报告');
    saveFact(chatId, 'decision', '税务申报', '准备报税材料');

    const context = await buildIntelligentContext(chatId, 'sys', '请处理报税材料');

    expect(systemText(context)).toContain('税务申报: 准备报税材料');
    expect(systemText(context)).not.toContain('报告归档: 保存季度报告');
  });

  it('uses token budget instead of fixed message count for history', async () => {
    const chatId = 'ctx_token_budget';
    // Insert many messages — token budget should determine how many are kept
    for (let i = 0; i < 15; i++) {
      saveMessage(chatId, i % 2 === 0 ? 'user' : 'assistant', `message ${i} content`);
    }

    const context = await buildIntelligentContext(
      chatId,
      'sys',
      'current question',
    );

    // Should have system prompt, some history, and current message
    expect(context[0].role).toBe('system');
    expect(context[context.length - 1]).toEqual({ role: 'user', content: 'current question' });
    // With a 100k token budget and small messages, all should fit without compression
    expect(context.length).toBeGreaterThan(2);
  });

  it('converts persisted artifact marker messages into summary context', async () => {
    const chatId = 'ctx_artifact_summary';
    const artifactMarker = encodeArtifactMarker({
      id: 'artifact_1',
      plugin_id: 'workspace_hub_v1',
      title: 'Artifact',
      status: 'completed',
      collapsed_by_default: true,
      fallback_text: 'fallback',
      data: { mission: { title: 'x' }, summary: 'final artifact summary' },
      updated_at: new Date().toISOString(),
    });

    saveMessage(chatId, 'user', 'before');
    saveMessage(chatId, 'assistant', artifactMarker);
    saveMessage(chatId, 'assistant', 'after');

    const context = await buildIntelligentContext(chatId, 'sys', 'now');
    expect(context.some(m => m.content === artifactMarker)).toBe(false);
    expect(context.some(m => m.role === 'assistant' && m.content.includes('[Artifact Summary] final artifact summary'))).toBe(true);
    expect(context.some(m => m.content === 'after')).toBe(true);
  });

  it('converts persisted tool artifact JSON into compact summary context', async () => {
    const chatId = 'ctx_tool_artifact_summary';
    const uniqueLargeBody = 'UNIQUE_ARTIFACT_BODY_SHOULD_NOT_REACH_LLM'.repeat(200);
    const artifactJson = JSON.stringify({
      _artifact: true,
      id: 'artifact_tool_1',
      plugin_id: 'sandpack_v1',
      title: 'Large Preview',
      status: 'completed',
      fallback_text: 'Preview ready',
      data: {
        content_type: 'html',
        code: uniqueLargeBody,
        summary: 'compact preview summary',
      },
      updated_at: new Date().toISOString(),
    });

    saveMessage(chatId, 'user', 'before');
    saveMessage(chatId, 'tool', artifactJson);
    saveMessage(chatId, 'assistant', 'after');

    const context = await buildIntelligentContext(chatId, 'sys', 'now');
    const joined = context.map(message => message.content).join('\n');
    expect(joined).toContain('[Artifact Summary] [Artifact: Large Preview (html)] compact preview summary');
    expect(joined).not.toContain(uniqueLargeBody);
    expect(joined).not.toContain(artifactJson);
    expect(context.some(m => m.content === 'after')).toBe(true);
  });

  it('injects project knowledge section into system prompt', async () => {
    const chatId = 'ctx_project_inject';
    const tenantId = 'project_test_tenant';
    saveProjectFact('tech_stack', 'React + TypeScript', 'fact', undefined, tenantId);
    saveProjectFact('package_manager', 'pnpm', 'preference', undefined, tenantId);

    const context = await buildIntelligentContext(
      chatId,
      'You are helpful.',
      'Help me set up the project.',
      tenantId,
    );

    expect(context[0].role).toBe('system');
    expect(context[0].content).toContain('## Project Knowledge');
    expect(context[0].content).toContain('tech_stack: React + TypeScript');
    expect(context[0].content).toContain('package_manager: pnpm');
  });

  it('project facts and user facts coexist without conflict', async () => {
    const chatId = 'ctx_project_user_coexist';
    const tenantId = 'coexist_tenant';

    // User-level fact
    saveFact(chatId, 'preference', 'editor', 'VSCode', undefined, tenantId);
    // Project-level fact
    saveProjectFact('runtime', 'Node.js 22', 'fact', undefined, tenantId);

    const context = await buildIntelligentContext(
      chatId,
      'You are helpful.',
      'What runtime do we use?',
      tenantId,
    );

    expect(context[0].content).toContain('editor: VSCode');
    expect(context[0].content).toContain('## Project Knowledge');
    expect(context[0].content).toContain('runtime: Node.js 22');
  });

  it('skips project section when no project facts exist', async () => {
    const chatId = 'ctx_no_project';
    const tenantId = 'no_project_tenant';

    const context = await buildIntelligentContext(
      chatId,
      'You are helpful.',
      'Hello',
      tenantId,
    );

    expect(context[0].content).not.toContain('## Project Knowledge');
  });

  it('does not inject regex-routed task modules — workflow knowledge is skill-pulled', async () => {
    const chatId = 'ctx_no_task_module';

    const context = await buildIntelligentContext(
      chatId,
      'You are helpful.',
      'Fix the bug in the TypeScript function and run tests',
    );

    // Task-type detection by keyword regex was removed (constitution: the
    // Brain makes routing decisions). Workflow guidance now lives in bundled
    // skills (research-workflow, data-analysis, ...) that the Brain activates
    // via use_skill; only the skills catalog appears unconditionally.
    expect(context[0].role).toBe('system');
    expect(context[0].content).not.toContain('Active Task Module');
    expect(context[0].content).toContain('## Available Skills');
  });

  it('injects file-based skill context from bundled SKILL.md files', async () => {
    const chatId = 'ctx_skill_injection';

    const context = await buildIntelligentContext(
      chatId,
      'You are helpful.',
      'Please review my code changes',
      'default',
    );

    // Skills are discovered from file system (bundled + workspace SKILL.md files)
    // The context builder uses discoverSkills from skills/loader.ts
    expect(context[0].role).toBe('system');
    // Whether skills are injected depends on bundled SKILL.md files existing
    expect(typeof context[0].content).toBe('string');
  });

  it('injects the skill catalog without non-always skill bodies', async () => {
    const context = await buildIntelligentContext(
      'ctx_skill_catalog',
      'You are helpful.',
      'Please review this TypeScript change',
      'default',
    );

    const systemContent = context[0].content;
    expect(systemContent).toContain('## Available Skills');
    expect(systemContent).toContain('Call `use_skill` with the exact skill name to activate full instructions under `## Active Skills`');
    expect(systemContent).toContain('- frontend-design: Guidance for distinctive, intentional visual design');
    expect(systemContent).not.toContain('# Frontend Design');
    expect(systemContent).toContain('## Always-On Skills');
    expect(systemContent).toContain('# Coding Agent');
  });

  it('sanitizes legacy shell-based delegation history when no managed worker job exists', async () => {
    const chatId = 'ctx_legacy_shell_delegation';
    saveMessage(chatId, 'assistant', 'Background process started.\nprocess_id: 071e0838-83a8-4453-8b45-fd9510fb527a\nUse process_status to continue.');

    const context = await buildIntelligentContext(
      chatId,
      'You are helpful.',
      '继续',
      'default',
    );

    const joined = context.map(message => message.content).join('\n');
    expect(joined).toContain('Legacy shell-based delegation omitted by runtime');
    expect(joined).not.toContain('071e0838-83a8-4453-8b45-fd9510fb527a');
    expect(joined).not.toContain('process_status');
  });

  it('ranks facts by recall score (high recall_count fact ranks above low)', async () => {
    const chatId = 'ctx_rank_score';
    const tenantId = 'rank_test';

    // Create two facts — both are 'fact' category (always included)
    saveFact(chatId, 'fact', 'low_recall', 'rarely used value', undefined, tenantId);
    saveFact(chatId, 'fact', 'high_recall', 'frequently used value', undefined, tenantId);

    // Boost recall count on high_recall
    const facts = getFacts(chatId, undefined, tenantId);
    const highFact = facts.find(f => f.key === 'high_recall')!;
    recordRecall([highFact.id]);
    recordRecall([highFact.id]);
    recordRecall([highFact.id]);

    const context = await buildIntelligentContext(
      chatId,
      'You are helpful.',
      'Tell me about the project.',
      tenantId,
    );

    const systemContent = context[0].content;
    const highPos = systemContent.indexOf('high_recall');
    const lowPos = systemContent.indexOf('low_recall');
    expect(highPos).toBeGreaterThan(-1);
    expect(lowPos).toBeGreaterThan(-1);
    // High recall fact should appear before low recall fact
    expect(highPos).toBeLessThan(lowPos);
  });

  it('includes semantic facts from __semantic__ in context', async () => {
    const chatId = 'ctx_semantic';
    const tenantId = 'semantic_test';

    // Save a semantic fact (consolidated)
    saveFact('__semantic__', 'preference', 'editor', 'vim', 'consolidation', tenantId);

    const context = await buildIntelligentContext(
      chatId,
      'You are helpful.',
      'Hello',
      tenantId,
    );

    expect(context[0].content).toContain('editor: vim');
  });

  it('falls back to keyword semantic recall when no embedding provider is available', async () => {
    const previousStrategy = getConfig().memory.recall_strategy;
    updateConfig('memory.recall_strategy', 'semantic');

    try {
      const chatId = 'ctx_semantic_keyword_fallback';
      saveFact(chatId, 'fact', 'vehicle', 'car', 'unit_test');

      const context = await buildIntelligentContext(
        chatId,
        'You are helpful.',
        'Tell me about the automobile.',
      );

      expect(context[0].content).toContain('vehicle: car');
    } finally {
      updateConfig('memory.recall_strategy', previousStrategy);
    }
  });

  it('accepts tenantId and userId parameters', async () => {
    const chatId = 'ctx_tenant_test';
    const tenantId = 'test_tenant';
    const userId = 'user_123';

    // Save facts under userId
    saveFact(userId, 'preference', 'theme', 'dark', undefined, tenantId);

    const context = await buildIntelligentContext(
      chatId,
      'sys',
      'hello',
      tenantId,
      userId,
    );

    expect(context[0].role).toBe('system');
    // Preference saved under userId should be found
    expect(context[0].content).toContain('theme: dark');
  });

  it('loads history from the active tenant only when chat ids collide', async () => {
    const chatId = 'ctx_shared_chat_tenant';
    saveMessage(chatId, 'user', 'Tenant A history', undefined, undefined, undefined, 'tenant_A');
    saveMessage(chatId, 'assistant', 'Tenant A reply', undefined, undefined, undefined, 'tenant_A');
    saveMessage(chatId, 'user', 'Tenant B history', undefined, undefined, undefined, 'tenant_B');
    saveMessage(chatId, 'assistant', 'Tenant B reply', undefined, undefined, undefined, 'tenant_B');

    const context = await buildIntelligentContext(
      chatId,
      'sys',
      'current tenant B message',
      'tenant_B',
    );

    const joined = context.map(message => message.content).join('\n');
    expect(joined).toContain('Tenant B history');
    expect(joined).toContain('Tenant B reply');
    expect(joined).not.toContain('Tenant A history');
    expect(joined).not.toContain('Tenant A reply');
  });

  it('exposes slot breakdown and enforces slot budgeting', async () => {
    const previousMaxTokens = getConfig().context.max_tokens;
    const previousThreshold = getConfig().context.compression_threshold;
    updateConfig('context.max_tokens', 180);
    updateConfig('context.compression_threshold', 0.6);

    try {
      const compiled = await compileIntelligentContext(
        'ctx_slot_budgeting',
        `System policy\n${'A'.repeat(2000)}`,
        'current request',
      );

      const identitySlot = compiled.slotBreakdown.find(slot => slot.name === 'identity');
      expect(identitySlot).toBeDefined();
      expect(identitySlot?.usedTokens).toBeLessThanOrEqual(identitySlot?.tokenCap ?? 0);
      expect(identitySlot?.fallbackApplied).toBe('trimmed');
      expect(compiled.systemSlotBudget).toBeGreaterThan(0);
      expect(compiled.systemSlotBudget).toBe(compiled.availableContextBudget);
      expect(compiled.systemSlotBudget).toBeGreaterThan(
        Math.floor(compiled.availableContextBudget * 0.6),
      );
      expect(compiled.historyTokenBudget).toBeGreaterThanOrEqual(0);
      const systemSlots = compiled.slotBreakdown.filter(slot => slot.name !== 'recent_history');
      expect(systemSlots.map(slot => slot.priority)).toEqual(
        [...systemSlots].map(slot => slot.priority).sort((left, right) => right - left),
      );
      expect(systemSlots.reduce((total, slot) => total + slot.usedTokens, 0))
        .toBeLessThanOrEqual(compiled.systemSlotBudget);
    } finally {
      updateConfig('context.max_tokens', previousMaxTokens);
      updateConfig('context.compression_threshold', previousThreshold);
    }
  });

  it('injects only runtime-verified deliverable paths owned by the active session', async () => {
    const tenantId = 'ctx_deliverable_tenant';
    const userId = 'ctx-deliverable-user';
    const session = createSession(userId, 'Deliverable context', tenantId);
    const workspace = getWorkspaceDir(userId);
    mkdirSync(workspace, { recursive: true });
    const deliverablePath = join(workspace, 'session-report.pdf');
    writeFileSync(deliverablePath, '%PDF-1.4\nverified');
    const canonicalPath = realpathSync(deliverablePath);
    saveTimelineItem({
      tenantId,
      sessionId: session.id,
      chatId: userId,
      turnId: 'turn-background-plan',
      type: 'artifact',
      eventKey: 'artifact:session-report',
      timestamp: Date.now(),
      data: {
        id: 'file-session-report',
        plugin_id: 'file_v1',
        title: 'Session Report',
        status: 'completed',
        data: { path: deliverablePath, filename: 'session-report.pdf' },
      },
    });

    const compiled = await compileIntelligentContext(
      userId,
      'sys',
      'How many pages is the report?',
      tenantId,
      userId,
      session.id,
    );
    const turnContext = turnSystemText(compiled.messages);
    expect(turnContext).toContain('## Current Session Deliverables');
    expect(turnContext).toContain(canonicalPath);
    expect(turnContext).toContain('Never guess a path');
    expect(compiled.slotBreakdown.find(slot => slot.name === 'session_deliverables')).toMatchObject({
      included: true,
      itemCount: 3,
      freshnessRule: 'session_timeline',
    });

    const wrongOwner = await compileIntelligentContext(
      'other-user',
      'sys',
      'Find the report',
      tenantId,
      'other-user',
      session.id,
    );
    expect(systemText(wrongOwner.messages)).not.toContain(canonicalPath);
    expect(wrongOwner.slotBreakdown.find(slot => slot.name === 'session_deliverables')?.included).toBe(false);
  });

  it('renders active skills once, respects the slot cap, and retires only at user-turn boundaries', async () => {
    const previousMaxTokens = getConfig().context.max_tokens;
    const previousThreshold = getConfig().context.compression_threshold;
    updateConfig('context.max_tokens', 900);
    updateConfig('context.compression_threshold', 0.8);

    const tenantId = 'active_skill_tenant';
    const chatId = 'ctx_active_skill';
    const sessionId = 'session-active-skill';
    const scope = activeSkillScope({ tenantId, chatId, sessionId });
    expect(scope).toBeTruthy();

    const skill: LoadedSkill = {
      name: 'demo-skill',
      description: 'Demo active skill',
      instructions: `# Demo Skill\n\n${'Follow this procedure carefully.\n'.repeat(400)}`,
      frontmatter: { name: 'demo-skill', description: 'Demo active skill' },
      filePath: '/skills/demo/SKILL.md',
      directoryName: 'demo',
      source: 'bundled',
      enabled: true,
      eligible: true,
    };

    try {
      beginActiveSkillUserTurn(scope!);
      activateSkill(scope!, skill);
      activateSkill(scope!, skill);

      const compiledNextTurn = await compileIntelligentContext(
        chatId,
        'sys',
        'continue active skill',
        tenantId,
        chatId,
        sessionId,
      );
      const nextTurnSystem = turnSystemText(compiledNextTurn.messages);
      expect(nextTurnSystem.match(/^## Active Skills$/gm)).toHaveLength(1);
      expect(nextTurnSystem.match(/### demo-skill/g)).toHaveLength(1);
      expect(nextTurnSystem).toContain('Demo active skill');
      const activeSlot = compiledNextTurn.slotBreakdown.find(slot => slot.name === 'active_skills');
      expect(activeSlot).toBeDefined();
      expect(activeSlot?.included).toBe(true);
      expect(activeSlot?.usedTokens).toBeLessThanOrEqual(activeSlot?.tokenCap ?? 0);

      expect(getActiveSkills(scope!)).toHaveLength(1);
      expect(getActiveSkills(scope!)).toHaveLength(1);

      // TTL is 3 user turns: the skill survives the next ACTIVE_SKILL_TTL_TURNS
      // turn boundaries after activation, then retires.
      for (let turn = 0; turn < ACTIVE_SKILL_TTL_TURNS - 1; turn += 1) {
        await compileIntelligentContext(chatId, 'sys', `follow-up ${turn}`, tenantId, chatId, sessionId);
        expect(getActiveSkills(scope!)).toHaveLength(1);
      }

      const compiledExpired = await compileIntelligentContext(
        chatId,
        'sys',
        'new request',
        tenantId,
        chatId,
        sessionId,
      );
      const expiredSystem = systemText(compiledExpired.messages);
      expect(expiredSystem).not.toMatch(/^## Active Skills$/m);
      expect(getActiveSkills(scope!)).toHaveLength(0);
    } finally {
      updateConfig('context.max_tokens', previousMaxTokens);
      updateConfig('context.compression_threshold', previousThreshold);
    }
  });

  it('refreshes active skill TTL when an active skill is loaded again', async () => {
    const previousMaxTokens = getConfig().context.max_tokens;
    const previousThreshold = getConfig().context.compression_threshold;
    updateConfig('context.max_tokens', 900);
    updateConfig('context.compression_threshold', 0.8);

    const tenantId = 'active_skill_refresh_tenant';
    const chatId = 'ctx_active_skill_refresh';
    const sessionId = 'session-active-skill-refresh';
    const scope = activeSkillScope({ tenantId, chatId, sessionId });
    expect(scope).toBeTruthy();

    const skill: LoadedSkill = {
      name: 'refresh-skill',
      description: 'Refreshable active skill',
      instructions: '# Refresh Skill\n\nFollow refreshed procedure.',
      frontmatter: { name: 'refresh-skill', description: 'Refreshable active skill' },
      filePath: '/skills/refresh/SKILL.md',
      directoryName: 'refresh',
      source: 'bundled',
      enabled: true,
      eligible: true,
    };

    try {
      beginActiveSkillUserTurn(scope!);
      activateSkill(scope!, skill);

      await compileIntelligentContext(chatId, 'sys', 'turn two', tenantId, chatId, sessionId);
      activateSkill(scope!, skill);

      const compiledThirdTurn = await compileIntelligentContext(chatId, 'sys', 'turn three', tenantId, chatId, sessionId);
      expect(turnSystemText(compiledThirdTurn.messages)).toContain('### refresh-skill');
      expect(getActiveSkills(scope!)).toHaveLength(1);

      // Loaded at turn 1, re-activated at turn 2: without the refresh it would
      // retire after turn 1 + ACTIVE_SKILL_TTL_TURNS; the refresh extends it
      // through turn 2 + ACTIVE_SKILL_TTL_TURNS, after which it retires.
      await compileIntelligentContext(chatId, 'sys', 'turn four', tenantId, chatId, sessionId);
      await compileIntelligentContext(chatId, 'sys', 'turn five', tenantId, chatId, sessionId);
      expect(getActiveSkills(scope!)).toHaveLength(1);

      await compileIntelligentContext(chatId, 'sys', 'turn six', tenantId, chatId, sessionId);
      expect(getActiveSkills(scope!)).toHaveLength(0);
    } finally {
      updateConfig('context.max_tokens', previousMaxTokens);
      updateConfig('context.compression_threshold', previousThreshold);
    }
  });

  it('keeps project knowledge in its own slot instead of duplicating it in memory facts', async () => {
    const chatId = 'ctx_project_slot_dedupe';
    const tenantId = 'project_slot_dedupe_tenant';
    saveProjectFact('runtime', 'Node.js 22', 'fact', undefined, tenantId);

    const compiled = await compileIntelligentContext(
      chatId,
      'sys',
      'What runtime do we use?',
      tenantId,
    );

    const systemContent = compiled.messages[0]?.content ?? '';
    expect(systemContent.match(/runtime: Node\.js 22/g)).toHaveLength(1);
  });

  it('drops stale episodic digests even when semantic search would otherwise surface them', async () => {
    const tenantId = 'stale_digest_tenant';
    const userId = 'stale_digest_user';
    const db = getDb();
    db.prepare(`
      INSERT INTO session_digests (
        tenant_id, session_id, user_id, digest, topics, open_threads, message_count,
        session_start, session_end, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tenantId,
      'sess-stale-digest',
      userId,
      'Legacy TypeScript migration discussion',
      JSON.stringify(['typescript']),
      JSON.stringify(['follow-up']),
      8,
      null,
      null,
      '2025-01-01 00:00:00',
    );

    const compiled = await compileIntelligentContext(
      'ctx_stale_digest',
      'sys',
      'Continue the TypeScript migration discussion',
      tenantId,
      userId,
    );

    const systemContent = compiled.messages[0]?.content ?? '';
    const digestSlot = compiled.slotBreakdown.find(slot => slot.name === 'episodic_digests');
    expect(systemContent).not.toContain('Legacy TypeScript migration discussion');
    expect(digestSlot?.included).toBe(false);
  });

  it('uses summary fallback for recent history when the history budget is exhausted', async () => {
    const previousMaxTokens = getConfig().context.max_tokens;
    const previousThreshold = getConfig().context.compression_threshold;
    updateConfig('context.max_tokens', 160);
    updateConfig('context.compression_threshold', 0.5);

    try {
      const chatId = 'ctx_history_summary_slot';
      for (let i = 0; i < 8; i++) {
        saveMessage(chatId, i % 2 === 0 ? 'user' : 'assistant', `history message ${i} ${'x'.repeat(120)}`);
      }

      const compiled = await compileIntelligentContext(
        chatId,
        'sys',
        'current question',
      );

      const historySlot = compiled.slotBreakdown.find(slot => slot.name === 'recent_history');
      expect(historySlot).toBeDefined();
      expect(historySlot?.fallbackApplied).toBe('summary');
      expect(compiled.messages.some(message => message.content.includes('[Conversation Summary]') || message.content.includes('[Compressed History]'))).toBe(true);
    } finally {
      updateConfig('context.max_tokens', previousMaxTokens);
      updateConfig('context.compression_threshold', previousThreshold);
    }
  });

  it('excludes irrelevant lessons from system prompt', async () => {
    const chatId = 'ctx_irrelevant_lessons';
    const tenantId = 'irrelevant_lessons_tenant';
    resetPruneTimestamp();

    // Save a lesson about Python — irrelevant to a TypeScript question
    saveLesson('python: virtualenv missing', 'Check virtualenv before importing', 'auto_feedback', tenantId);
    // Save a lesson about TypeScript — relevant
    saveLesson('typescript: strict mode', 'Enable strict mode in tsconfig', 'auto_feedback', tenantId);

    const context = await buildIntelligentContext(
      chatId,
      'You are helpful.',
      'Fix the TypeScript tsconfig compilation',
      tenantId,
    );

    const systemContent = systemText(context);
    expect(systemContent).toContain('typescript');
    expect(systemContent).toContain('Enable strict mode');
    expect(systemContent).not.toContain('virtualenv');
  });

  it('includes advisory header for lessons section', async () => {
    const chatId = 'ctx_advisory_header';
    const tenantId = 'advisory_header_tenant';
    resetPruneTimestamp();

    saveLesson('shell: timeout', 'Increase timeout for slow commands', 'auto_feedback', tenantId);

    const context = await buildIntelligentContext(
      chatId,
      'You are helpful.',
      'Run a shell command with timeout',
      tenantId,
    );

    const systemContent = systemText(context);
    if (systemContent.includes('## Lessons Learned')) {
      expect(systemContent).toContain('These are past observations for reference only');
      expect(systemContent).toContain('Always prioritize executing the user\'s current request');
    }
  });

  it('does not inject dirty ENOENT path strings into the system prompt', async () => {
    const chatId = 'ctx_dirty_path_prompt';
    const tenantId = 'dirty_path_prompt_tenant';
    resetPruneTimestamp();

    saveLesson(
      "read_file: ENOENT: no such file or directory, open '/home/example/workspace/repos/Mozi/src/ghost.ts'",
      `Tool "read_file" failed: ENOENT: no such file or directory, open '/home/example/workspace/repos/Mozi/src/ghost.ts'.`,
      'auto_feedback',
      tenantId,
    );

    const context = await buildIntelligentContext(
      chatId,
      'You are helpful.',
      'Inspect the missing file in this TypeScript repo',
      tenantId,
    );

    const systemContent = systemText(context);
    expect(systemContent).toContain('locate the file');
    expect(systemContent).not.toContain('/home/example/workspace/repos/Mozi/src/ghost.ts');
  });

  it('sanitizes stale attachment paths in historical messages before context injection', async () => {
    const chatId = 'ctx_stale_attachment';
    const tenantId = 'stale_attachment_tenant';
    resetPruneTimestamp();

    // Simulate old polluted history with absolute workspace tmp paths
    saveMessage(chatId, 'user', 'Please analyze this image', undefined, undefined, undefined, tenantId);
    saveMessage(
      chatId,
      'assistant',
      'I can see the image at /home/user/.mozi/workspace/tmp/1234567890-abc123-photo.jpg — it shows a cat.',
      undefined, undefined, undefined, tenantId,
    );
    saveMessage(
      chatId,
      'user',
      'The file /home/user/.mozi/workspace/tmp/1234567890-abc123-photo.jpg has a dog too',
      undefined, undefined, undefined, tenantId,
    );

    const compiled = await compileIntelligentContext(
      chatId,
      'You are helpful.',
      'What was in that photo?',
      tenantId,
    );

    // History messages should have sanitized paths
    const allContent = compiled.messages.map(m => m.content).join('\n');
    expect(allContent).not.toContain('/home/user/.mozi/workspace/tmp/');
    expect(allContent).toContain('[attachment: photo.jpg]');
    // Semantic content should be preserved
    expect(allContent).toContain('cat');
  });

  it('marks historical photo analysis as previous-turn context', async () => {
    const chatId = 'ctx_historical_photo_analysis';
    const tenantId = 'historical_photo_tenant';

    saveMessage(
      chatId,
      'user',
      'Photo Analysis:\n1. Photo 1: An old skyline image.\n\nWhat is this?',
      undefined, undefined, undefined, tenantId,
    );
    saveMessage(
      chatId,
      'user',
      'Current Photo Analysis (attached to this message):\n1. Photo 1: An older body scan.\n\nLook at this',
      undefined, undefined, undefined, tenantId,
    );

    const currentMessage = 'Current Photo Analysis (attached to this message):\n1. Photo 1: The current chart.\n\n看一下这个图';
    const compiled = await compileIntelligentContext(
      chatId,
      'You are helpful.',
      currentMessage,
      tenantId,
    );

    const historicalSkyline = compiled.messages.find(m => m.content.includes('old skyline'));
    const historicalScan = compiled.messages.find(m => m.content.includes('older body scan'));
    const current = compiled.messages[compiled.messages.length - 1];

    expect(historicalSkyline?.content).toContain('Historical Photo Analysis (previous turn; not attached to the current message)');
    expect(historicalScan?.content).toContain('Historical Photo Analysis (previous turn; not attached to the current message)');
    expect(historicalSkyline?.content).not.toMatch(/^Photo Analysis:/m);
    expect(historicalScan?.content).not.toMatch(/^Current Photo Analysis/m);
    expect(current.content).toContain('Current Photo Analysis (attached to this message)');
    expect(current.content).toContain('The current chart');
  });

  it('scopes history to the active session — prior sessions on the same chat do not bleed in', async () => {
    const chatId = 'ctx_session_isolation';
    // Old session: GitHub Trending discussion
    saveMessage(chatId, 'user', 'show me github trending', undefined, undefined, 'session_old_111');
    saveMessage(chatId, 'assistant', 'Here is GitHub Trending: OpenClaw 365k stars', undefined, undefined, 'session_old_111');
    // Active session: body-fat analysis
    saveMessage(chatId, 'user', 'analyze my body fat report', undefined, undefined, 'session_new_222');
    saveMessage(chatId, 'assistant', 'Body fat is 18%, height 175cm', undefined, undefined, 'session_new_222');

    const ctx = await buildIntelligentContext(
      chatId,
      'You are helpful.',
      'why is this conversation strange?',
      'default',
      chatId,
      'session_new_222',
    );

    const historyText = ctx.map(m => m.content).join('\n');
    // Active session content must be present
    expect(historyText).toContain('analyze my body fat report');
    expect(historyText).toContain('Body fat is 18%, height 175cm');
    // Prior session content must NOT bleed in
    expect(historyText).not.toContain('show me github trending');
    expect(historyText).not.toContain('OpenClaw');
  });

  it('appends authoritative runtime time anchor to the system prompt tail every turn', async () => {
    const ctx = await buildIntelligentContext(
      'ctx_time_anchor',
      'You are helpful.',
      'hello',
    );

    expect(ctx[0].role).toBe('system');
    const turnSystem = turnSystemText(ctx);
    expect(turnSystem).toContain('[RUNTIME TIME FACTS — authoritative]');
    expect(turnSystem).toContain('utc_iso=');
    expect(turnSystem).toContain('local_iso=');
    expect(turnSystem).toContain('Treat this as the only ground truth for "now".');

    // The anchor changes every turn (epoch_ms), so it must sit at the END of
    // the system prompt: placing it first would invalidate provider prompt
    // caching from token zero on every turn.
    expect(ctx.at(-2)?.role).toBe('system');
    expect(ctx.at(-1)?.role).toBe('user');
  });

  it('falls back to chat-wide history when no sessionId is given (back-compat)', async () => {
    const chatId = 'ctx_session_backcompat';
    saveMessage(chatId, 'user', 'first ever message', undefined, undefined, 'session_a');
    saveMessage(chatId, 'assistant', 'first ever reply', undefined, undefined, 'session_b');

    const ctx = await buildIntelligentContext(
      chatId,
      'You are helpful.',
      'continue',
    );

    const historyText = ctx.map(m => m.content).join('\n');
    expect(historyText).toContain('first ever message');
    expect(historyText).toContain('first ever reply');
  });
});

describe('sanitizeStaleAttachmentPaths', () => {
  it('replaces absolute .mozi/workspace/tmp paths with placeholder', () => {
    const input = 'See /home/user/.mozi/workspace/tmp/1234567890-abc123-photo.jpg for details';
    const result = sanitizeStaleAttachmentPaths(input);
    expect(result).toBe('See [attachment: photo.jpg] for details');
    expect(result).not.toContain('/home/user/.mozi/workspace/tmp/');
  });

  it('handles multiple stale paths in one message', () => {
    const input = [
      '1. /home/user/.mozi/workspace/tmp/111111-aaa-cat.jpg: A cute cat',
      '2. /home/user/.mozi/workspace/tmp/222222-bbb-dog.png: A happy dog',
    ].join('\n');
    const result = sanitizeStaleAttachmentPaths(input);
    expect(result).toContain('[attachment: cat.jpg]');
    expect(result).toContain('[attachment: dog.png]');
    expect(result).not.toContain('/home/user/.mozi/workspace/tmp/');
  });

  it('replaces relative workspace tmp paths', () => {
    const input = 'Photo Analysis:\n1. workspace/tmp/1777043230219-usba99-photo.jpg: A skyline';
    const result = sanitizeStaleAttachmentPaths(input);
    expect(result).toContain('[attachment: photo.jpg]');
    expect(result).not.toContain('workspace/tmp/');
  });

  it('replaces standalone generated Telegram photo filenames', () => {
    const generatedName = '1777043230219-usba99-AgACAgQAAxkBAAIJDmnrhx3BEh39emsoHfC3Sd8bSW4G.jpg';
    const input = `Photo Analysis:\n1. ${generatedName}: A skyline`;
    const result = sanitizeStaleAttachmentPaths(input);
    expect(result).toContain('[attachment file omitted]');
    expect(result).not.toContain(generatedName);
  });

  it('marks photo analysis headings as historical for prior turns', () => {
    const legacy = 'Photo Analysis:\n1. Photo 1: Old image';
    const current = 'Current Photo Analysis (attached to this message):\n1. Photo 1: Current image';

    expect(markHistoricalPhotoAnalysis(legacy)).toContain(
      'Historical Photo Analysis (previous turn; not attached to the current message)',
    );
    expect(markHistoricalPhotoAnalysis(current)).toContain(
      'Historical Photo Analysis (previous turn; not attached to the current message)',
    );
  });

  it('leaves normal file paths untouched', () => {
    const input = 'Edit /home/user/projects/app/src/index.ts and /etc/nginx/nginx.conf';
    const result = sanitizeStaleAttachmentPaths(input);
    expect(result).toBe(input);
  });

  it('leaves workspace paths that are not in tmp/ untouched', () => {
    const input = 'Skills are in /home/user/.mozi/workspace/skills/my-skill/SKILL.md';
    const result = sanitizeStaleAttachmentPaths(input);
    expect(result).toBe(input);
  });

  it('handles expanded home directory paths', () => {
    const input = 'File at /root/.mozi/workspace/tmp/9876543210-xyz789-report.pdf is ready';
    const result = sanitizeStaleAttachmentPaths(input);
    expect(result).toBe('File at [attachment: report.pdf] is ready');
  });

  it('returns unchanged content when no stale paths exist', () => {
    const input = 'Hello, how are you? Let me help with TypeScript.';
    expect(sanitizeStaleAttachmentPaths(input)).toBe(input);
  });

  it('preserves empty content', () => {
    expect(sanitizeStaleAttachmentPaths('')).toBe('');
  });

  it('handles custom workspace dir with /tmp/ subpath', () => {
    const input = 'See /data/my-workspace/tmp/1234567890-abc123-scan.jpg for the scan';
    const result = sanitizeStaleAttachmentPaths(input);
    expect(result).toBe('See [attachment: scan.jpg] for the scan');
  });
});
