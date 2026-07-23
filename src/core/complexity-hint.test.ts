import { describe, it, expect } from 'vitest';
import { shouldSuggestDecomposition } from './complexity-hint.js';
import { resolveRuntimeAdmission } from './durable-plan-admission.js';

describe('shouldSuggestDecomposition', () => {
  it('returns true for Chinese comparison of multiple products', () => {
    expect(shouldSuggestDecomposition('帮我对比 A、B、C 三个产品')).toBe(true);
  });

  it('returns false for simple creative request', () => {
    expect(shouldSuggestDecomposition('写一首诗')).toBe(false);
  });

  it('returns true for English research + comparison', () => {
    expect(shouldSuggestDecomposition('Research competitors X, Y, Z and write a comparison report')).toBe(true);
  });

  it('requires a durable plan for the production macro research PDF request', () => {
    const prompt = 'Collect the latest U.S. macroeconomic data, including CPI, PCE, unemployment, nonfarm payrolls, retail sales, GDP growth, Fed funds expectations, and Treasury yields. Quantitatively assess how these indicators may affect the U.S. bond market across the yield curve. Generate a detailed PDF report with visualizations, scenario analysis, and implications for short-, medium-, and long-duration bonds. The report must have standard content for this kind of report.';
    expect(shouldSuggestDecomposition(prompt)).toBe(true);
  });

  it('does not force a durable plan for a small report formatting request', () => {
    expect(shouldSuggestDecomposition('Summarize this paragraph as a short report.')).toBe(false);
  });

  it('does not treat a question about an existing report as a production request', () => {
    expect(shouldSuggestDecomposition('What data sources does this report use in its analysis? Please explain the chart.')).toBe(false);
  });

  it('does not force a short analysis summary into a durable plan', () => {
    expect(shouldSuggestDecomposition('Analyze the data below and summarize it as a short report.')).toBe(false);
  });

  it('requires durable plans across production task categories', () => {
    const prompts = [
      'Build a production-ready SaaS application with authentication, billing, organization roles, an admin dashboard, audit logs, automated tests, Docker packaging, deployment configuration, and operator documentation.',
      'Create an ETL pipeline that ingests source connectors, validates and deduplicates records, loads a warehouse, schedules retries, adds monitoring, and includes tests and deployment documentation.',
      'Create a board presentation with sourced analysis, scenario charts, an executive summary, recommendations, speaker notes, and an appendix.',
      'Develop a signed desktop installer with authentication, an admin dashboard, audit logging, automated tests, packaging, deployment automation, and operator documentation.',
    ];
    for (const prompt of prompts) expect(shouldSuggestDecomposition(prompt)).toBe(true);
  });

  it('uses structural breadth for complex products outside the domain vocabulary', () => {
    expect(shouldSuggestDecomposition(
      'Build an online marketplace with seller onboarding, product catalog, search, cart, checkout, payments, order tracking, reviews, admin moderation, tests, and deployment.',
    )).toBe(true);
    expect(shouldSuggestDecomposition(
      'Automate a desktop Excel workflow that opens 20 workbooks, cleans rows, creates pivots, updates charts, exports PDFs, emails results, and logs failures.',
    )).toBe(true);
  });

  it('does not let small-format words hide a bulk deliverable', () => {
    expect(shouldSuggestDecomposition(
      'Create a brief one-page report for each of 50 countries.',
    )).toBe(true);
    expect(shouldSuggestDecomposition(
      'Create a simple one-page report summarizing this paragraph.',
    )).toBe(false);
  });

  it('routes explicit control of a running plan to plan tools instead of a duplicate DAG', () => {
    const prompt = 'Continue the current plan. Step 1: retry the failed research. Step 2: regenerate the final report.';
    expect(resolveRuntimeAdmission(prompt, { hasNonTerminalPlan: true })).toBe('plan_control');
    expect(resolveRuntimeAdmission(prompt, { hasNonTerminalPlan: false })).toBe('durable_plan');
  });

  it('routes schedule creation ahead of the complexity of its future workload', () => {
    const prompt = '我需要构建一个定时任务，每天中国 A 股收盘后 15 分钟，搜索调研最新行情并生成 dashboard。';
    expect(resolveRuntimeAdmission(prompt)).toBe('scheduler_control');
  });

  it('routes schedule inspection and cancellation to scheduler control', () => {
    expect(resolveRuntimeAdmission('查看我的定时任务')).toBe('scheduler_control');
    expect(resolveRuntimeAdmission('取消那个提醒')).toBe('scheduler_control');
  });

  it('returns false for short messages', () => {
    expect(shouldSuggestDecomposition('Hello')).toBe(false);
  });

  it('returns true for Chinese research + report request', () => {
    expect(shouldSuggestDecomposition('帮我调研三个竞品然后写报告')).toBe(true);
  });

  it('returns false for simple bug fix', () => {
    expect(shouldSuggestDecomposition('Fix the bug in line 42')).toBe(false);
  });

  it('returns true for multiple + summarize pattern', () => {
    expect(shouldSuggestDecomposition('Compare multiple SaaS products and summarize findings')).toBe(true);
  });

  it('returns false for simple translation', () => {
    expect(shouldSuggestDecomposition('翻译这段话')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(shouldSuggestDecomposition('')).toBe(false);
  });

  it('returns true for analyze N files pattern', () => {
    expect(shouldSuggestDecomposition('Analyze these 5 files and then create separate test files for each')).toBe(true);
  });

  it('returns false for non-string input coerced to empty', () => {
    expect(shouldSuggestDecomposition(undefined as any)).toBe(false);
  });

  it('returns true for sequential multi-step with count', () => {
    expect(shouldSuggestDecomposition('调研这3个竞品然后写一份分析总结报告')).toBe(true);
  });

  // Regression: the real production prompt that slipped through — a task
  // explicitly organized into 阶段一/二/三 matched only ONE old signal
  // ("三个区域") and never got the decomposition hint. Phase markers must
  // short-circuit to true.
  it('returns true for a prompt explicitly organized into Chinese phases (production regression)', () => {
    const prompt = [
      '**任务：季度税务动态更新 —— 分析框架模板 + 内容初版 + 提交**',
      '**背景** 面向本公司的 Q2 2026 税务动态汇编，覆盖三个区域。',
      '**阶段一：构建分析框架模板** 工具：Python + openpyxl。',
      '**阶段二：填充内容初版** 按区域、按国家逐条录入。',
      '**阶段三：提交** 导出最终 xlsx，提交评审。',
    ].join('\n');
    expect(shouldSuggestDecomposition(prompt)).toBe(true);
  });

  it('returns true for English Phase/Step structured prompts', () => {
    expect(shouldSuggestDecomposition(
      'Build the data pipeline.\nPhase 1: ingest the sources.\nPhase 2: transform and validate.\nPhase 3: publish the dashboard.',
    )).toBe(true);
    expect(shouldSuggestDecomposition(
      'Step 1: scaffold the project. Step 2: implement the API. Step 3: write tests.',
    )).toBe(true);
  });

  it('a single phase mention alone does not trigger', () => {
    expect(shouldSuggestDecomposition('这个阶段先不用管，帮我把这句话翻译成英文就行')).toBe(false);
  });
});
