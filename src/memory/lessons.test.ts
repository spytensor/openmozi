import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  saveLesson,
  getLessons,
  searchLessons,
  incrementApplied,
  recordToolOutcome,
  autoGenerateLesson,
  autoGenerateSuccessLesson,
  recordUserCorrectionLesson,
  searchLessonsForTool,
  updateEffectiveness,
  getRankedLessons,
  getRankedLessonsForContext,
  pruneExpiredLessons,
  resetPruneTimestamp,
} from './lessons.js';
import { getDb } from '../store/db.js';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';

let tmpDir: string;

beforeAll(() => {
  const result = setupTestDb();
  tmpDir = result.tmpDir;
});

afterAll(() => {
  teardownTestDb(tmpDir);
});

describe('memory/lessons', () => {
  it('saves and retrieves lessons most recent first', () => {
    saveLesson('error 429', 'Retry with exponential backoff');
    saveLesson('timeout', 'Increase timeout and retry');

    const lessons = getLessons();
    expect(lessons.length).toBeGreaterThanOrEqual(2);
    expect(lessons[0].trigger_pattern).toBe('timeout');
    expect(lessons[0].lesson).toBe('Increase timeout and retry');
    expect(lessons[1].trigger_pattern).toBe('error 429');
  });

  it('stores source and defaults times_applied to 0', () => {
    saveLesson('permission denied', 'Ask for required permission', 'postmortem');
    const lessons = searchLessons('permission denied');
    expect(lessons).toHaveLength(1);
    expect(lessons[0].source).toBe('postmortem');
    expect(lessons[0].times_applied).toBe(0);
  });

  it('includes effectiveness_score and last_applied_at in results', () => {
    saveLesson('score test', 'Test lesson with score');
    const [lesson] = searchLessons('score test');
    expect(lesson.effectiveness_score).toBe(0);
    expect(lesson.last_applied_at).toBeNull();
  });

  it('supports simple LIKE search on trigger_pattern', () => {
    saveLesson('api rate limit exceeded', 'Sleep and retry');
    saveLesson('api malformed payload', 'Validate payload schema');

    const matches = searchLessons('rate limit');
    expect(matches).toHaveLength(1);
    expect(matches[0].trigger_pattern).toContain('rate limit');
  });

  it('increments times_applied counter', () => {
    saveLesson('network hiccup', 'Retry once before failing');
    const [lesson] = searchLessons('network hiccup');
    expect(lesson.times_applied).toBe(0);

    incrementApplied(lesson.id);

    const [updated] = searchLessons('network hiccup');
    expect(updated.times_applied).toBe(1);
  });

  it('respects limit parameter', () => {
    saveLesson('limit test one', 'a');
    saveLesson('limit test two', 'b');
    saveLesson('limit test three', 'c');

    const lessons = getLessons('default', 2);
    expect(lessons).toHaveLength(2);
  });

  it('isolates lessons by tenant_id', () => {
    saveLesson('same trigger', 'tenant A lesson', undefined, 'tenant_a');
    saveLesson('same trigger', 'tenant B lesson', undefined, 'tenant_b');

    const tenantA = getLessons('tenant_a');
    const tenantB = getLessons('tenant_b');
    expect(tenantA).toHaveLength(1);
    expect(tenantA[0].lesson).toBe('tenant A lesson');
    expect(tenantB).toHaveLength(1);
    expect(tenantB[0].lesson).toBe('tenant B lesson');
  });
});

describe('recordToolOutcome', () => {
  it('inserts and retrieves a tool outcome', () => {
    recordToolOutcome({
      chatId: 'chat_1',
      turnId: 'turn_1',
      iteration: 0,
      toolName: 'shell',
      toolCallId: 'tc_001',
      outcome: 'success',
      durationMs: 150,
    });

    const db = getDb();
    const row = db.prepare(`SELECT * FROM tool_outcomes WHERE tool_call_id = ?`).get('tc_001') as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(row.tool_name).toBe('shell');
    expect(row.outcome).toBe('success');
    expect(row.duration_ms).toBe(150);
    expect(row.error_summary).toBeNull();
  });

  it('records error outcomes with error_summary', () => {
    recordToolOutcome({
      chatId: 'chat_2',
      turnId: 'turn_2',
      iteration: 1,
      toolName: 'read_file',
      toolCallId: 'tc_002',
      outcome: 'error',
      errorSummary: 'File not found: /tmp/missing.txt',
      durationMs: 5,
    });

    const db = getDb();
    const row = db.prepare(`SELECT * FROM tool_outcomes WHERE tool_call_id = ?`).get('tc_002') as Record<string, unknown>;
    expect(row.outcome).toBe('error');
    expect(row.error_summary).toBe('File not found: /tmp/missing.txt');
  });
});

describe('autoGenerateLesson', () => {
  it('abstracts ENOENT failures into reusable file-grounding lessons', () => {
    autoGenerateLesson(
      'read_file',
      "ENOENT: no such file or directory, open '/home/example/workspace/repos/Mozi/src/missing.ts'",
      'auto_gen_tenant',
    );
    const lessons = getLessons('auto_gen_tenant');
    expect(lessons).toHaveLength(1);
    expect(lessons[0].trigger_pattern).toBe('read_file: failure:missing_path');
    expect(lessons[0].source).toBe('auto_feedback');
    expect(lessons[0].lesson).toContain('locate the file');
    expect(lessons[0].lesson).not.toContain('/home/example');
  });

  it('abstracts approval-pending failures without storing approval IDs', () => {
    autoGenerateLesson(
      'shell_exec',
      '[APPROVAL NEEDED] ID: approval-42 Use /approve approval-42',
      'approval_auto_gen_tenant',
    );

    const lessons = getLessons('approval_auto_gen_tenant');
    expect(lessons).toHaveLength(1);
    expect(lessons[0].trigger_pattern).toBe('shell_exec: failure:approval_pending');
    expect(lessons[0].lesson).toContain('wait for approval');
    expect(lessons[0].trigger_pattern).not.toContain('approval-42');
    expect(lessons[0].lesson).not.toContain('approval-42');
  });

  it('abstracts blocked-command failures into safer retry guidance', () => {
    autoGenerateLesson(
      'shell_exec',
      'shell_exec is blocked by RBAC (requires L2_SHELL_EXEC). Do not call shell_exec again in this turn.',
      'blocked_auto_gen_tenant',
    );

    const lessons = getLessons('blocked_auto_gen_tenant');
    expect(lessons).toHaveLength(1);
    expect(lessons[0].trigger_pattern).toBe('shell_exec: failure:blocked_command');
    expect(lessons[0].lesson).toContain('safer allowed tool');
  });

  it('deduplicates within 24h window', () => {
    const tenant = 'dedup_tenant';
    autoGenerateLesson('shell', 'command not found: xyz', tenant);
    autoGenerateLesson('shell', 'command not found: abc', tenant);

    const lessons = getLessons(tenant);
    expect(lessons).toHaveLength(1);
    expect(lessons[0].trigger_pattern).toBe('shell: failure:command_not_found');
  });
});

describe('autoGenerateSuccessLesson', () => {
  it('generates a lesson from a successful tool outcome', () => {
    autoGenerateSuccessLesson('read_file', 'Read package.json and extracted scripts', 'success_tenant');
    const lessons = getLessons('success_tenant');
    expect(lessons).toHaveLength(1);
    expect(lessons[0].source).toBe('auto_success');
    expect(lessons[0].trigger_pattern).toContain('read_file: success');
  });

  it('deduplicates success lessons within 7 days', () => {
    const tenant = 'success_dedup_tenant';
    autoGenerateSuccessLesson('read_file', 'Read package.json', tenant);
    autoGenerateSuccessLesson('read_file', 'Read package.json', tenant);
    const lessons = getLessons(tenant);
    expect(lessons).toHaveLength(1);
  });
});

describe('recordUserCorrectionLesson', () => {
  it('stores high-priority correction lessons', () => {
    const tenant = 'user_correction_tenant';
    recordUserCorrectionLesson('你这次理解错了，应该先跑测试再改代码。', tenant);
    const lessons = getLessons(tenant);
    expect(lessons).toHaveLength(1);
    expect(lessons[0].source).toBe('user_correction');
    expect(lessons[0].effectiveness_score).toBe(0.9);
  });
});

describe('searchLessonsForTool', () => {
  it('finds lessons matching tool name prefix', () => {
    const tenant = 'tool_search_tenant';
    saveLesson('shell: timeout after 30s', 'Use shorter timeout', 'auto_feedback', tenant);
    saveLesson('shell: permission denied', 'Check user permissions', 'auto_feedback', tenant);
    saveLesson('read_file: not found', 'Verify path exists', 'auto_feedback', tenant);

    const shellLessons = searchLessonsForTool('shell', tenant);
    expect(shellLessons).toHaveLength(2);
    expect(shellLessons.every(l => l.trigger_pattern.startsWith('shell:'))).toBe(true);

    const readLessons = searchLessonsForTool('read_file', tenant);
    expect(readLessons).toHaveLength(1);
  });

  it('orders by effectiveness_score descending', () => {
    const tenant = 'tool_search_order_tenant';
    saveLesson('grep: no results', 'Try broader pattern', 'test', tenant);
    saveLesson('grep: bad pattern', 'Validate regex before search', 'test', tenant);

    const lessons = searchLessonsForTool('grep', tenant);
    // Update one lesson's effectiveness
    updateEffectiveness(lessons[1].id, true); // boost the second one

    const reordered = searchLessonsForTool('grep', tenant);
    expect(reordered[0].trigger_pattern).toContain('bad pattern'); // higher score first
  });

  it('respects limit parameter', () => {
    const tenant = 'tool_search_limit_tenant';
    saveLesson('fs: a', 'lesson a', 'auto_feedback', tenant);
    saveLesson('fs: b', 'lesson b', 'auto_feedback', tenant);
    saveLesson('fs: c', 'lesson c', 'auto_feedback', tenant);

    const limited = searchLessonsForTool('fs', tenant, 2);
    expect(limited).toHaveLength(2);
  });

  it('abstracts legacy dirty failure lessons on retrieval', () => {
    const tenant = 'tool_search_dirty_retrieval_tenant';
    saveLesson(
      'shell_exec: [APPROVAL NEEDED] ID: approval-42 Use /approve approval-42',
      'Tool "shell_exec" failed: [APPROVAL NEEDED] ID: approval-42 Use /approve approval-42',
      'auto_feedback',
      tenant,
    );
    saveLesson(
      'shell_exec: blocked by RBAC (requires L2_SHELL_EXEC)',
      'Tool "shell_exec" failed: blocked by RBAC (requires L2_SHELL_EXEC)',
      'auto_feedback',
      tenant,
    );

    const lessons = searchLessonsForTool('shell_exec', tenant, 5);
    expect(lessons.some(l => l.trigger_pattern === 'shell_exec: failure:approval_pending')).toBe(true);
    expect(lessons.some(l => l.trigger_pattern === 'shell_exec: failure:blocked_command')).toBe(true);
    expect(lessons.every(l => !l.trigger_pattern.includes('approval-42'))).toBe(true);
    expect(lessons.every(l => !l.lesson.includes('approval-42'))).toBe(true);
  });
});

describe('updateEffectiveness', () => {
  it('increases score on success', () => {
    const tenant = 'eff_inc_tenant';
    saveLesson('test_tool: err', 'fix it', 'auto_feedback', tenant);
    const [lesson] = searchLessonsForTool('test_tool', tenant);
    expect(lesson.effectiveness_score).toBe(0);

    updateEffectiveness(lesson.id, true);

    const [updated] = searchLessonsForTool('test_tool', tenant);
    // 0 * 0.8 + 0.2 = 0.2
    expect(updated.effectiveness_score).toBeCloseTo(0.2);
    expect(updated.times_applied).toBe(1);
    expect(updated.last_applied_at).toBeTruthy();
  });

  it('decreases score on failure', () => {
    const tenant = 'eff_dec_tenant';
    saveLesson('fail_tool: err', 'fix it', 'auto_feedback', tenant);
    const [lesson] = searchLessonsForTool('fail_tool', tenant);

    updateEffectiveness(lesson.id, false);

    const [updated] = searchLessonsForTool('fail_tool', tenant);
    // 0 * 0.8 + (-0.1) = -0.1
    expect(updated.effectiveness_score).toBeCloseTo(-0.1);
  });

  it('clamps score to [-1.0, 1.0]', () => {
    const tenant = 'eff_clamp_tenant';
    saveLesson('clamp_tool: err', 'fix it', 'auto_feedback', tenant);
    const [lesson] = searchLessonsForTool('clamp_tool', tenant);

    // Repeatedly succeed to push score high
    for (let j = 0; j < 30; j++) {
      updateEffectiveness(lesson.id, true);
    }
    const [high] = searchLessonsForTool('clamp_tool', tenant);
    expect(high.effectiveness_score).toBeLessThanOrEqual(1.0);

    // Repeatedly fail to push score low
    for (let j = 0; j < 50; j++) {
      updateEffectiveness(lesson.id, false);
    }
    const [low] = searchLessonsForTool('clamp_tool', tenant);
    expect(low.effectiveness_score).toBeGreaterThanOrEqual(-1.0);
  });
});

describe('getRankedLessons', () => {
  it('returns lessons ordered by effectiveness_score DESC', () => {
    const tenant = 'ranked_tenant';
    saveLesson('ranked_a', 'lesson a', 'test', tenant);
    saveLesson('ranked_b', 'lesson b', 'test', tenant);
    saveLesson('ranked_c', 'lesson c', 'test', tenant);

    const lessons = getLessons(tenant);
    // Boost lesson a
    updateEffectiveness(lessons.find(l => l.trigger_pattern === 'ranked_a')!.id, true);
    updateEffectiveness(lessons.find(l => l.trigger_pattern === 'ranked_a')!.id, true);
    // Boost lesson c once
    updateEffectiveness(lessons.find(l => l.trigger_pattern === 'ranked_c')!.id, true);

    const ranked = getRankedLessons(tenant);
    expect(ranked[0].trigger_pattern).toBe('ranked_a');
    expect(ranked[1].trigger_pattern).toBe('ranked_c');
    expect(ranked[2].trigger_pattern).toBe('ranked_b');
  });

  it('filters out lessons with effectiveness_score <= -0.5', () => {
    const tenant = 'ranked_filter_tenant';
    saveLesson('good_lesson', 'works well', 'test', tenant);
    saveLesson('bad_lesson', 'does not help', 'test', tenant);

    const lessons = getLessons(tenant);
    const badId = lessons.find(l => l.trigger_pattern === 'bad_lesson')!.id;
    // Drive effectiveness below -0.5 — need enough iterations for EMA to converge past threshold
    // First boost it with a success so score starts positive, then fail repeatedly
    // Or just set it directly. We'll use many failures:
    // EMA with delta=-0.1 converges to -0.5 but slowly. Use a success then many failures to cross.
    updateEffectiveness(badId, true); // score = 0.2
    for (let j = 0; j < 5; j++) {
      updateEffectiveness(badId, false); // successive failures
    }
    // score after: 0.2*0.8^5 + (-0.1)*(0.8^4+0.8^3+0.8^2+0.8+1) ≈ not enough
    // Simpler: set score to exactly -0.6 via raw SQL
    const db = getDb();
    db.prepare('UPDATE lessons SET effectiveness_score = -0.6 WHERE id = ?').run(badId);

    const ranked = getRankedLessons(tenant);
    expect(ranked.every(l => l.trigger_pattern !== 'bad_lesson')).toBe(true);
    expect(ranked.some(l => l.trigger_pattern === 'good_lesson')).toBe(true);
  });

  it('respects limit parameter', () => {
    const tenant = 'ranked_limit_tenant';
    for (let j = 0; j < 15; j++) {
      saveLesson(`rl_${j}`, `lesson ${j}`, 'test', tenant);
    }

    const ranked = getRankedLessons(tenant, 5);
    expect(ranked).toHaveLength(5);
  });

  it('applies time decay — older lessons rank lower', () => {
    const tenant = 'ranked_decay_tenant';
    const db = getDb();

    saveLesson('decay_old', 'old lesson', 'test', tenant);
    saveLesson('decay_new', 'new lesson', 'test', tenant);

    // Give both the same effectiveness score
    const lessons = getLessons(tenant);
    const oldId = lessons.find(l => l.trigger_pattern === 'decay_old')!.id;
    const newId = lessons.find(l => l.trigger_pattern === 'decay_new')!.id;
    db.prepare('UPDATE lessons SET effectiveness_score = 0.5 WHERE id = ?').run(oldId);
    db.prepare('UPDATE lessons SET effectiveness_score = 0.5 WHERE id = ?').run(newId);

    // Age the old lesson by 120 days
    db.prepare("UPDATE lessons SET created_at = datetime('now', '-120 days') WHERE id = ?").run(oldId);

    const ranked = getRankedLessons(tenant);
    const oldIdx = ranked.findIndex(l => l.trigger_pattern === 'decay_old');
    const newIdx = ranked.findIndex(l => l.trigger_pattern === 'decay_new');
    expect(newIdx).toBeLessThan(oldIdx);
  });
});

describe('getRankedLessonsForContext', () => {
  it('only includes lessons relevant to the query', () => {
    const tenant = 'context_relevance_tenant';
    resetPruneTimestamp();
    saveLesson('typescript: strict mode', 'Enable strict mode in tsconfig', 'auto_feedback', tenant);
    saveLesson('python: virtualenv missing', 'Check virtualenv before importing', 'auto_feedback', tenant);
    saveLesson('shell: permission denied /etc/passwd', 'Avoid reading system files', 'auto_feedback', tenant);

    const lessons = getRankedLessonsForContext('Help me configure TypeScript tsconfig', tenant);
    expect(lessons.some(l => l.trigger_pattern.includes('typescript'))).toBe(true);
    expect(lessons.every(l => !l.trigger_pattern.includes('python'))).toBe(true);
    expect(lessons.every(l => !l.trigger_pattern.includes('shell'))).toBe(true);
  });

  it('requires a Chinese word match instead of a shared single Han character', () => {
    const tenant = 'context_cjk_word_relevance_tenant';
    resetPruneTimestamp();
    saveLesson('报告异常', '重新生成报告文件', 'auto_feedback', tenant);
    saveLesson('报税失败', '重新检查报税材料', 'auto_feedback', tenant);

    const lessons = getRankedLessonsForContext('处理报税失败', tenant);

    expect(lessons.some(lesson => lesson.trigger_pattern === '报税失败')).toBe(true);
    expect(lessons.some(lesson => lesson.trigger_pattern === '报告异常')).toBe(false);
  });

  it('always includes user_correction lessons regardless of relevance', () => {
    const tenant = 'context_correction_tenant';
    resetPruneTimestamp();
    recordUserCorrectionLesson('Always run tests before committing', tenant);
    saveLesson('unrelated: xyz', 'Something unrelated', 'auto_feedback', tenant);

    const lessons = getRankedLessonsForContext('Deploy the application', tenant);
    expect(lessons.some(l => l.source === 'user_correction')).toBe(true);
  });

  it('respects limit parameter', () => {
    const tenant = 'context_limit_tenant';
    resetPruneTimestamp();
    for (let j = 0; j < 10; j++) {
      saveLesson(`tool: error ${j}`, `lesson about error ${j}`, 'auto_feedback', tenant);
    }

    const lessons = getRankedLessonsForContext('error handling', tenant, 3);
    expect(lessons.length).toBeLessThanOrEqual(3);
  });

  it('filters out ineffective lessons (score <= -0.5)', () => {
    const tenant = 'context_ineffective_tenant';
    const db = getDb();
    resetPruneTimestamp();
    saveLesson('tool: bad error', 'Bad lesson about error', 'auto_feedback', tenant);
    const [lesson] = getLessons(tenant);
    db.prepare('UPDATE lessons SET effectiveness_score = -0.6 WHERE id = ?').run(lesson.id);

    const lessons = getRankedLessonsForContext('error in tool', tenant);
    expect(lessons.every(l => l.trigger_pattern !== 'tool: bad error')).toBe(true);
  });

  it('filters dirty ENOENT path strings from reusable context lessons', () => {
    const tenant = 'context_dirty_path_filter_tenant';
    resetPruneTimestamp();
    saveLesson(
      "read_file: ENOENT: no such file or directory, open '/home/example/workspace/repos/Mozi/src/runtime/missing.ts'",
      `Tool "read_file" failed: ENOENT: no such file or directory, open '/home/example/workspace/repos/Mozi/src/runtime/missing.ts'.`,
      'auto_feedback',
      tenant,
    );

    const lessons = getRankedLessonsForContext('Help me locate the missing file in this repo', tenant);
    expect(lessons).toHaveLength(1);
    expect(lessons[0].trigger_pattern).toBe('read_file: failure:missing_path');
    expect(lessons[0].lesson).toContain('locate the file');
    expect(lessons[0].trigger_pattern).not.toContain('/home/example');
    expect(lessons[0].lesson).not.toContain('/home/example');
  });
});

describe('pruneExpiredLessons', () => {
  it('deletes old auto-generated lessons with low effectiveness', () => {
    const tenant = 'prune_tenant';
    const db = getDb();

    saveLesson('shell: old error', 'Old lesson', 'auto_feedback', tenant);
    saveLesson('shell: new error', 'New lesson', 'auto_feedback', tenant);
    saveLesson('user_correction:keep', 'User taught this', 'user_correction', tenant);

    const lessons = getLessons(tenant);
    const oldId = lessons.find(l => l.trigger_pattern === 'shell: old error')!.id;
    // Age beyond 90 days and keep low score
    db.prepare("UPDATE lessons SET created_at = datetime('now', '-100 days'), effectiveness_score = 0.05 WHERE id = ?").run(oldId);

    const pruned = pruneExpiredLessons(tenant);
    expect(pruned).toBe(1);

    const remaining = getLessons(tenant);
    expect(remaining.every(l => l.trigger_pattern !== 'shell: old error')).toBe(true);
    // New lesson and user_correction should remain
    expect(remaining.some(l => l.trigger_pattern === 'shell: new error')).toBe(true);
    expect(remaining.some(l => l.source === 'user_correction')).toBe(true);
  });

  it('keeps old lessons with high effectiveness', () => {
    const tenant = 'prune_keep_tenant';
    const db = getDb();

    saveLesson('shell: effective old', 'Good old lesson', 'auto_feedback', tenant);
    const [lesson] = getLessons(tenant);
    db.prepare("UPDATE lessons SET created_at = datetime('now', '-100 days'), effectiveness_score = 0.5 WHERE id = ?").run(lesson.id);

    const pruned = pruneExpiredLessons(tenant);
    expect(pruned).toBe(0);
    expect(getLessons(tenant)).toHaveLength(1);
  });
});
