import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import { create, resetColumnsEnsured, type TaskRecord } from '../store/task-dag.js';
import { appendTranscriptBatch, persistTaskResult } from '../tasks/workspace.js';
import { getWorkspaceDir } from '../tools/workspace-policy.js';
import { saveTimelineItem } from '../memory/session-timeline.js';
import type { ChatResponse, LLMClient } from './llm.js';
import { requiresFreshnessVerification, verifyPlanSemantics } from './plan-semantic-verifier.js';

function scriptedClient(content: string): LLMClient {
  const response: ChatResponse = {
    content,
    usage: { input_tokens: 10, output_tokens: 10 },
    model: 'semantic-verifier-test',
    stop_reason: 'end_turn',
  };
  return {
    provider: 'test',
    chat: vi.fn(async () => response),
    chatStream: vi.fn(),
  } as unknown as LLMClient;
}

function createResearchStep(): TaskRecord {
  return create({
    tenant_id: 'default',
    title: 'Research latest CPI',
    objective: 'Collect the latest U.S. CPI release and sources',
    done_criteria: 'Latest release is dated and cited',
  });
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function persistResearchEvidence(step: TaskRecord, year: number): string {
  const callId = 'call-cpi';
  const evidenceId = `${step.id}:${callId}`;
  persistTaskResult(step.id, {
    task_id: step.id,
    success: true,
    output: `The latest CPI release is June ${year}, according to BLS.`,
    tokens_used: 0,
    elapsed_ms: 5,
    completed_at: `${year}-07-17T10:00:00.000Z`,
  });
  appendTranscriptBatch(step.id, [
    {
      timestamp: `${year}-07-17T09:59:00.000Z`,
      type: 'tool_call',
      data: {
        tool_name: 'web_search',
        tool_call_id: callId,
        arguments: { query: `BLS latest CPI June ${year}` },
        evidence_kind: 'research_source',
      },
    },
    {
      timestamp: `${year}-07-17T09:59:01.000Z`,
      type: 'tool_result',
      data: {
        tool_name: 'web_search',
        tool_call_id: callId,
        is_error: false,
        content_evidence: `1. CPI Home — BLS\nhttps://bls.gov/cpi\nJune ${year} CPI release.`,
      },
    },
  ]);
  return evidenceId;
}

function persistSchedulerEvidence(step: TaskRecord): string {
  const callId = 'call-cron';
  const evidenceId = `${step.id}:${callId}`;
  persistTaskResult(step.id, {
    task_id: step.id,
    success: true,
    output: 'MOZI schedule creation completed.',
    tokens_used: 0,
    elapsed_ms: 5,
    completed_at: '2026-07-20T10:00:00.000Z',
  });
  appendTranscriptBatch(step.id, [
    {
      timestamp: '2026-07-20T09:59:00.000Z',
      type: 'tool_call',
      data: {
        tool_name: 'set_cron_task',
        tool_call_id: callId,
        arguments: { schedule_value: '15 15 * * 1-5', timezone: 'Asia/Shanghai' },
        evidence_kind: 'scheduler_control',
      },
    },
    {
      timestamp: '2026-07-20T09:59:01.000Z',
      type: 'tool_result',
      data: {
        tool_name: 'set_cron_task',
        tool_call_id: callId,
        is_error: false,
        content_evidence: 'MOZI 定时任务已创建（ID：cron_acceptance_test）。',
      },
    },
  ]);
  return evidenceId;
}

describe('plan semantic verifier', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = setupTestDb().tmpDir;
    resetColumnsEnsured();
  });

  afterEach(() => {
    teardownTestDb(tmpDir);
  });

  it('only requires the gate for freshness-sensitive goals', () => {
    expect(requiresFreshnessVerification('Write a quarterly tax report')).toBe(false);
    expect(requiresFreshnessVerification('Refactor the current UI implementation')).toBe(false);
    expect(requiresFreshnessVerification('Collect the latest CPI release')).toBe(true);
    expect(requiresFreshnessVerification('收集最新美国宏观经济数据')).toBe(true);
  });

  it('requires semantic verification for ordinary complex plans too', async () => {
    const report = await verifyPlanSemantics({
      rootTaskId: 'root',
      tenantId: 'default',
      originalRequest: 'Write a quarterly tax report',
      planGoal: 'Write a quarterly tax report',
      steps: [],
      now: new Date('2026-07-17T10:00:00.000Z'),
    });
    expect(report).toMatchObject({ required: true, passed: false, outcome: 'unverified', verdict: 'uncertain' });
    expect(report.summary).toContain('No verifier model');
  });

  it('truncates astral characters at the evidence budget without a lone surrogate', async () => {
    const step = create({
      tenant_id: 'default', title: 'Write report', objective: 'Write report', done_criteria: 'Report is persisted',
    });
    persistTaskResult(step.id, {
      task_id: step.id, success: true, output: `${'a'.repeat(3499)}😀tail`, tokens_used: 0,
      elapsed_ms: 5, completed_at: '2026-07-22T10:00:00.000Z',
    });
    const client = scriptedClient(JSON.stringify({
      verdict: 'passed', summary: 'The report is present.', findings: [], evidence_ids: [`result:${step.id}`],
    }));

    await verifyPlanSemantics({
      rootTaskId: 'unicode-root', tenantId: 'default', originalRequest: 'Write report', planGoal: 'Write report',
      steps: [step], client, now: new Date('2026-07-22T10:00:00.000Z'),
    });

    const [messages] = (client.chat as ReturnType<typeof vi.fn>).mock.calls[0] as [Array<{ content: string }>];
    const serialized = JSON.stringify(messages);
    expect(hasLoneSurrogate(messages[1].content)).toBe(false);
    expect(JSON.parse(serialized)).toEqual(messages);
    expect(messages[1].content).toContain(`${'a'.repeat(20)}😀`);
  });

  it('degrades uncertain and deterministic verifier errors without retrying', async () => {
    const uncertain = scriptedClient('{"verdict":"uncertain","summary":"Evidence is incomplete.","findings":[],"evidence_ids":[]}');
    const uncertainReport = await verifyPlanSemantics({
      rootTaskId: 'uncertain-root', tenantId: 'default', originalRequest: 'Write report', planGoal: 'Write report',
      steps: [], client: uncertain, now: new Date('2026-07-22T10:00:00.000Z'),
    });
    expect(uncertainReport).toMatchObject({ passed: false, outcome: 'unverified', verdict: 'uncertain' });

    const badRequest = scriptedClient('unused');
    vi.mocked(badRequest.chat).mockRejectedValueOnce(new Error('Bad Request: unexpected end of hex escape'));
    const errorReport = await verifyPlanSemantics({
      rootTaskId: 'bad-request-root', tenantId: 'default', originalRequest: 'Write report', planGoal: 'Write report',
      steps: [], client: badRequest, now: new Date('2026-07-22T10:00:00.000Z'),
    });
    expect(errorReport).toMatchObject({ passed: false, outcome: 'unverified', verdict: 'uncertain' });
    expect(errorReport.findings.join('\n')).toContain('hex escape');
    expect(badRequest.chat).toHaveBeenCalledTimes(1);
  });

  it('retries transient provider failures with bounded backoff', async () => {
    vi.useFakeTimers();
    try {
      const client = scriptedClient('{"verdict":"uncertain","summary":"Could not establish quality.","findings":[],"evidence_ids":[]}');
      vi.mocked(client.chat)
        .mockRejectedValueOnce(new Error('HTTP 503 service unavailable'))
        .mockRejectedValueOnce(new Error('network error: ECONNRESET'));
      const pending = verifyPlanSemantics({
        rootTaskId: 'retry-root', tenantId: 'default', originalRequest: 'Write report', planGoal: 'Write report',
        steps: [], client, now: new Date('2026-07-22T10:00:00.000Z'),
      });
      await vi.runAllTimersAsync();
      await expect(pending).resolves.toMatchObject({ outcome: 'unverified' });
      expect(client.chat).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps deterministic evidence failures while also running semantic verification', async () => {
    const step = createResearchStep();
    persistTaskResult(step.id, {
      task_id: step.id,
      success: true,
      output: 'Latest CPI is 3.5%.',
      tokens_used: 0,
      elapsed_ms: 5,
      completed_at: '2026-07-17T10:00:00.000Z',
    });
    const client = scriptedClient('{"verdict":"passed","summary":"ok","findings":[],"evidence_ids":[]}');

    const report = await verifyPlanSemantics({
      rootTaskId: 'root',
      tenantId: 'default',
      originalRequest: 'Collect the latest CPI release',
      planGoal: 'Collect CPI',
      steps: [step],
      client,
      now: new Date('2026-07-17T10:00:00.000Z'),
    });

    expect(report).toMatchObject({ passed: false, outcome: 'failed' });
    expect(report.findings[0]).toContain('No persisted source evidence');
    expect(client.chat).toHaveBeenCalledTimes(1);
  });

  it('aggregates the runtime-year failure with model verification', async () => {
    const step = createResearchStep();
    persistResearchEvidence(step, 2025);
    const client = scriptedClient('{"verdict":"passed","summary":"ok","findings":[],"evidence_ids":[]}');

    const report = await verifyPlanSemantics({
      rootTaskId: 'root',
      tenantId: 'default',
      originalRequest: 'Collect the latest CPI release',
      planGoal: 'Collect CPI',
      steps: [step],
      client,
      now: new Date('2026-07-17T10:00:00.000Z'),
    });

    expect(report.passed).toBe(false);
    expect(report.findings[0]).toContain('runtime year 2026');
    expect(client.chat).toHaveBeenCalledTimes(1);
  });

  it('requires a passed verifier verdict grounded in a real persisted evidence id', async () => {
    const step = createResearchStep();
    const evidenceId = persistResearchEvidence(step, 2026);
    const client = scriptedClient(JSON.stringify({
      verdict: 'passed',
      summary: 'The dated conclusion matches the persisted BLS observation.',
      findings: [],
      evidence_ids: [evidenceId],
    }));

    const report = await verifyPlanSemantics({
      rootTaskId: 'root',
      tenantId: 'default',
      originalRequest: 'Collect the latest CPI release',
      planGoal: 'Collect CPI',
      steps: [step],
      client,
      now: new Date('2026-07-17T10:00:00.000Z'),
    });

    expect(report).toMatchObject({ required: true, passed: true, verdict: 'passed' });
    expect(report.evidenceIds).toEqual([evidenceId]);
    expect(client.chat).toHaveBeenCalledTimes(1);
    expect(client.chat).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        think: false,
        temperature: 0,
        max_tokens: 1600,
      }),
    );
  });

  it('blocks a model pass that cites no supplied evidence', async () => {
    const step = createResearchStep();
    persistResearchEvidence(step, 2026);
    const client = scriptedClient(JSON.stringify({
      verdict: 'passed',
      summary: 'Looks current.',
      findings: [],
      evidence_ids: ['invented:evidence'],
    }));

    const report = await verifyPlanSemantics({
      rootTaskId: 'root',
      tenantId: 'default',
      originalRequest: 'Collect the latest CPI release',
      planGoal: 'Collect CPI',
      steps: [step],
      client,
      now: new Date('2026-07-17T10:00:00.000Z'),
    });

    expect(report.passed).toBe(false);
    expect(report.findings[0]).toContain('valid persisted evidence ID');
  });

  it('rejects a persisted result that claims an exact sentence count but includes extra prose', async () => {
    const step = create({
      tenant_id: 'default',
      title: '写两句中文总结',
      objective: '根据上一步结果写总结',
      done_criteria: '恰好两句中文。第一句包含 ORIGINAL-REQUEST-KEPT，第二句包含 DONE-CRITERIA-ENFORCED。',
    });
    persistTaskResult(step.id, {
      task_id: step.id,
      success: true,
      output: [
        '以下内容严格遵循两句要求。',
        '计算结果为 50 和 8，ORIGINAL-REQUEST-KEPT。',
        'DONE-CRITERIA-ENFORCED 确保输出两句。',
      ].join('\n'),
      tokens_used: 0,
      elapsed_ms: 5,
      completed_at: '2026-07-19T10:00:00.000Z',
    });
    const client = scriptedClient(JSON.stringify({
      verdict: 'passed',
      summary: '结果自称符合两句要求。',
      findings: [],
      evidence_ids: [`result:${step.id}`],
    }));

    const report = await verifyPlanSemantics({
      rootTaskId: 'exact-sentence-root',
      tenantId: 'default',
      originalRequest: '写恰好两句中文总结。',
      planGoal: '写中文总结',
      steps: [step],
      client,
      now: new Date('2026-07-19T10:00:00.000Z'),
    });

    expect(report).toMatchObject({ passed: false, verdict: 'failed' });
    expect(report.findings.join('\n')).toContain('requires exactly 2 sentences');
    expect(report.findings.join('\n')).toContain('contains 3');
    expect(client.chat).toHaveBeenCalledTimes(1);
  });

  it('rejects the demographics incident against the original request and persisted HTML', async () => {
    const step = create({
      tenant_id: 'default',
      title: 'Build dashboard',
      objective: 'Build demographic visualizations',
      done_criteria: 'All requested periods, entities, annotations, and charts are present',
    });
    persistTaskResult(step.id, {
      task_id: step.id,
      success: true,
      output: 'Dashboard covers four countries from 1950 through 2023 with five visualizations.',
      tokens_used: 0,
      elapsed_ms: 5,
      completed_at: '2026-07-19T10:00:00.000Z',
    });
    const artifactDir = join(getWorkspaceDir(), 'artifacts', 'semantic-test');
    mkdirSync(artifactDir, { recursive: true });
    const artifactPath = join(artifactDir, 'demographics.html');
    writeFileSync(artifactPath, '<script src="https://cdn.jsdelivr.net/npm/d3@7"></script><script>const years=[1950,2023]; function drawWaterfall(){}</script>');
    saveTimelineItem({
      tenantId: 'default', sessionId: 'session-incident', chatId: 'chat-incident', turnId: 'turn_bg_root',
      type: 'artifact', eventKey: 'artifact:incident', timestamp: Date.now(),
      data: {
        id: 'incident', plugin_id: 'sandpack_v1', title: 'Global Demographics Dashboard', status: 'completed',
        persisted_path: artifactPath,
        data: { code: '<script>/* DATA_JSON_PLACEHOLDER */</script>' },
      },
    });
    const client = scriptedClient('{"verdict":"passed","summary":"ok","findings":[],"evidence_ids":["artifact:incident"]}');

    const report = await verifyPlanSemantics({
      rootTaskId: 'root', tenantId: 'default', sessionId: 'session-incident', turnId: 'turn_bg_root',
      originalRequest: '基于联合国人口司数据分析1950–2100年，包含预测、2035中国标注、以色列异常点和2024–2050区域人口增量瀑布图。',
      planGoal: 'Create demographic visualizations',
      steps: [step], client,
      now: new Date('2026-07-19T10:00:00.000Z'),
    });

    expect(report).toMatchObject({ required: true, passed: false, verdict: 'failed' });
    expect(report.findings.join('\n')).toContain('cdn.jsdelivr.net');
    expect(client.chat).toHaveBeenCalledTimes(1);
  });

  it('asks the verifier to compare the full original scope when the planner goal is lossy', async () => {
    const step = create({
      tenant_id: 'default', title: 'Build dashboard', objective: 'Build five charts',
      done_criteria: 'Requested dashboard is produced',
    });
    persistTaskResult(step.id, {
      task_id: step.id, success: true,
      output: 'Dashboard covers China, India, Japan and the U.S. from 1950 through 2023.',
      tokens_used: 0, elapsed_ms: 5, completed_at: '2026-07-19T10:00:00.000Z',
    });
    const client = scriptedClient(JSON.stringify({
      verdict: 'failed',
      summary: 'The persisted result narrows the requested period and omits explicit analyses.',
      findings: ['No 2024–2100 projections or 2024–2050 regional contribution waterfall are evidenced.'],
      evidence_ids: [`result:${step.id}`],
    }));
    const originalRequest = '覆盖1950–2100年预测，并提供2024–2050区域人口增量瀑布图和中国2035年标注。';
    const planGoal = 'Create five demographic visualizations';
    const report = await verifyPlanSemantics({
      rootTaskId: 'scope-root', tenantId: 'default', originalRequest, planGoal,
      steps: [step], client, now: new Date('2026-07-19T10:00:00.000Z'),
    });

    expect(report).toMatchObject({ passed: false, verdict: 'failed' });
    const [messages] = (client.chat as ReturnType<typeof vi.fn>).mock.calls[0] as [Array<{ role: string; content: string }>];
    const verifierInput = messages.find((message) => message.role === 'user')?.content ?? '';
    expect(verifierInput).toContain(originalRequest);
    expect(verifierInput).toContain(planGoal);
    expect(verifierInput).toContain('1950 through 2023');
  });

  it('uses the persisted file as artifact evidence instead of a stale timeline snapshot', async () => {
    const step = create({
      tenant_id: 'default', title: 'Build dashboard', objective: 'Build dashboard', done_criteria: 'Dashboard is complete',
    });
    persistTaskResult(step.id, {
      task_id: step.id, success: true, output: 'Dashboard completed and validated.', tokens_used: 0,
      elapsed_ms: 5, completed_at: '2026-07-19T10:00:00.000Z',
    });
    const artifactDir = join(getWorkspaceDir(), 'artifacts', 'disk-truth-test');
    mkdirSync(artifactDir, { recursive: true });
    const artifactPath = join(artifactDir, 'complete.html');
    writeFileSync(artifactPath, '<script>const years=[1950,2100]; function drawWaterfall(){ return true; }</script><h1>Complete dashboard</h1>');
    saveTimelineItem({
      tenantId: 'default', sessionId: 'session-disk', chatId: 'chat-disk', turnId: 'turn_bg_disk',
      type: 'artifact', eventKey: 'artifact:disk', timestamp: Date.now(),
      data: {
        id: 'disk', plugin_id: 'sandpack_v1', title: 'Complete dashboard', status: 'completed',
        persisted_path: artifactPath,
        data: { code: '<script src="https://bad.example/d3.js">/* DATA_JSON_PLACEHOLDER */</script>' },
      },
    });
    const client = scriptedClient('{"verdict":"passed","summary":"All requirements are evidenced.","findings":[],"evidence_ids":["artifact:disk"]}');
    const report = await verifyPlanSemantics({
      rootTaskId: 'disk-root', tenantId: 'default', sessionId: 'session-disk', turnId: 'turn_bg_disk',
      originalRequest: 'Build a complete dashboard covering 1950–2100.', planGoal: 'Build dashboard',
      steps: [step], client,
      now: new Date('2026-07-19T10:00:00.000Z'),
    });
    expect(report).toMatchObject({ passed: true, verdict: 'passed', evidenceIds: ['artifact:disk'] });
  });

  it('fails closed instead of using a stale snapshot when a declared persisted file is unavailable', async () => {
    const step = create({
      tenant_id: 'default', title: 'Build dashboard', objective: 'Build dashboard', done_criteria: 'Dashboard is complete',
    });
    persistTaskResult(step.id, {
      task_id: step.id, success: true, output: 'Dashboard completed.', tokens_used: 0,
      elapsed_ms: 5, completed_at: '2026-07-19T10:00:00.000Z',
    });
    saveTimelineItem({
      tenantId: 'default', sessionId: 'session-stale-path', chatId: 'chat-stale-path', turnId: 'turn_bg_stale_path',
      type: 'artifact', eventKey: 'artifact:stale-path', timestamp: Date.now(),
      data: {
        id: 'stale-path', plugin_id: 'sandpack_v1', title: 'Stale path dashboard', status: 'completed',
        persisted_path: join(getWorkspaceDir(), 'artifacts', 'missing', 'dashboard.html'),
        data: { code: '<h1>This stale snapshot must not count as persisted evidence</h1>' },
      },
    });
    const client = scriptedClient('{"verdict":"passed","summary":"ok","findings":[],"evidence_ids":["artifact:stale-path"]}');

    const report = await verifyPlanSemantics({
      rootTaskId: 'stale-path-root', tenantId: 'default', sessionId: 'session-stale-path', turnId: 'turn_bg_stale_path',
      originalRequest: 'Build a complete dashboard.', planGoal: 'Build dashboard', steps: [step], client,
      now: new Date('2026-07-19T10:00:00.000Z'),
    });

    expect(report).toMatchObject({ passed: false, verdict: 'failed' });
    expect(report.findings.join('\n')).toContain('could not be verified from its persisted file');
    expect(client.chat).toHaveBeenCalledTimes(1);
  });

  it('rejects scheduler completion without a persisted MOZI receipt and preserves model findings', async () => {
    const step = create({
      tenant_id: 'default', title: 'Create schedule', objective: 'Create the recurring task',
      done_criteria: 'A MOZI cron task id is persisted',
    });
    persistTaskResult(step.id, {
      task_id: step.id, success: true, output: 'Cron configured.', tokens_used: 0, elapsed_ms: 5,
      completed_at: '2026-07-20T10:00:00.000Z',
    });
    const client = scriptedClient(JSON.stringify({
      verdict: 'failed',
      summary: 'The configured schedule is not evidenced.',
      findings: ['No next-run time or managed handler contract is present.'],
      evidence_ids: [`result:${step.id}`],
    }));
    const report = await verifyPlanSemantics({
      rootTaskId: 'scheduler-root', tenantId: 'default',
      originalRequest: '创建一个每天收盘后生成复盘的定时任务。', planGoal: 'Create recurring report',
      steps: [step], client, now: new Date('2026-07-20T10:00:00.000Z'),
    });

    expect(report).toMatchObject({ passed: false, verdict: 'failed' });
    expect(report.findings.join('\n')).toContain('No successful MOZI set_cron_task receipt');
    expect(report.findings.join('\n')).toContain('No next-run time');
    expect(client.chat).toHaveBeenCalledTimes(1);
  });

  it('accepts a schedule only when the persisted set_cron_task receipt is cited', async () => {
    const step = create({
      tenant_id: 'default', title: 'Create schedule', objective: 'Create the recurring task',
      done_criteria: 'A MOZI cron task id is persisted',
    });
    const evidenceId = persistSchedulerEvidence(step);
    const client = scriptedClient(JSON.stringify({
      verdict: 'passed', summary: 'The MOZI schedule receipt proves creation.', findings: [], evidence_ids: [evidenceId],
    }));
    const report = await verifyPlanSemantics({
      rootTaskId: 'scheduler-root', tenantId: 'default',
      originalRequest: '创建一个每天收盘后生成复盘的定时任务。', planGoal: 'Create recurring report',
      steps: [step], client, now: new Date('2026-07-20T10:00:00.000Z'),
    });
    expect(report).toMatchObject({ passed: true, verdict: 'passed', evidenceIds: [evidenceId] });
  });
});
