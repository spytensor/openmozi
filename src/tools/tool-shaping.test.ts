import { describe, expect, it } from 'vitest';
import { ALL_TOOLS } from './definitions.js';
import {
  detectTaskToolProfile,
  shapePromptMessagesForExecution,
  shapeToolsForExecution,
} from './tool-shaping.js';

function names(result: ReturnType<typeof shapeToolsForExecution>): string[] {
  return result.tools.map(tool => tool.function.name);
}

describe('task-aware tool shaping', () => {
  it('detects Chinese and English task profiles', () => {
    expect(detectTaskToolProfile('帮我修复 TypeScript bug 并运行测试')).toBe('coding');
    expect(detectTaskToolProfile('Create an Excel spreadsheet and save it')).toBe('office');
    expect(detectTaskToolProfile('研究并对比最新的三个产品')).toBe('research');
    expect(detectTaskToolProfile('打开桌面应用并点击登录按钮')).toBe('desktop');
    expect(detectTaskToolProfile('Why is the sky blue?')).toBe('simple');
  });

  describe('report profile', () => {
    it('recognises document production that no other profile claims', () => {
      // Issue #702 §D: "generate a PDF report" previously fell through to
      // `general` and was handed the entire registry.
      expect(detectTaskToolProfile('generate a PDF report of the macro data')).toBe('report');
      expect(detectTaskToolProfile('收集美债宏观数据，做曲线和情景分析，生成中文 PDF 报告')).toBe('report');
      expect(detectTaskToolProfile('把这些材料编排成一份白皮书')).toBe('report');
    });

    it('leaves code work about PDFs to coding, which keeps git', () => {
      // `pdf`/`report` are ordinary nouns in code work. Routing these to `report`
      // silently drops all 7 git tools, run_tests and delegate_coding_task — and
      // PDF handling is an active work area in this repo.
      expect(detectTaskToolProfile('fix the pdf.js CJK cmaps bug')).toBe('coding');
      expect(detectTaskToolProfile('refactor the pdf parser in src/pdf/')).toBe('coding');
      expect(detectTaskToolProfile('the test report is failing, fix it')).toBe('coding');
      expect(detectTaskToolProfile('add a pdf export feature and open a PR')).toBe('coding');
    });

    it('recognises the Chinese periodic-report vocabulary', () => {
      // These previously fell through to `general` — the 44-tool surface #702 blamed.
      for (const text of ['写一份周报', '生成月报', '出一份年报']) {
        expect(detectTaskToolProfile(text), text).toBe('report');
      }
    });

    it('yields to a more specific document profile, but claims document production', () => {
      // `office` still owns concrete office formats.
      expect(detectTaskToolProfile('Create an Excel spreadsheet and save it')).toBe('office');
      // Gathering with no deliverable stays research.
      expect(detectTaskToolProfile('研究并对比最新的三个产品')).toBe('research');
      expect(detectTaskToolProfile('Fix this repository bug and run tests')).toBe('coding');
      // A request that names a report *is* a report task, even when it also
      // mentions a market: `finance` carries no TASKS and so could not plan it.
      expect(detectTaskToolProfile('Analyze the finance market and create a report artifact')).toBe('report');
    });

    it('keeps the planning tools a multi-step report needs', () => {
      const shaped = shapeToolsForExecution({
        tools: ALL_TOOLS,
        userText: '收集美债宏观数据，做曲线和情景分析，生成中文 PDF 报告',
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
      });
      expect(shaped.taskProfile).toBe('report');
      // A report is the archetypal multi-step job. Withholding decompose_task
      // here would recreate the bug this profile exists to help.
      expect(names(shaped)).toEqual(expect.arrayContaining([
        'decompose_task', 'create_artifact', 'write_file', 'shell_exec', 'web_search',
      ]));
      // Control-plane and unrelated surface stays out.
      expect(names(shaped)).not.toEqual(expect.arrayContaining(['set_cron_task', 'git_commit', 'desktop_click']));
      // Narrower than the 44-tool general surface Issue #702 blamed.
      expect(shaped.shapedCount).toBeLessThan(44);
    });

    it('fails closed to skill activation and DAG creation during durable-plan admission', () => {
      const dynamic = { type: 'function' as const, function: { name: 'tenant_custom', description: 'custom', parameters: { type: 'object' } } };
      const shaped = shapeToolsForExecution({
        tools: [...ALL_TOOLS, dynamic],
        userText: 'Collect current macro data, perform scenario analysis, and generate a PDF report with charts.',
        runtimeAdmission: 'durable_plan',
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
      });

      expect(shaped.taskProfile).toBe('report');
      expect(new Set(names(shaped))).toEqual(new Set(['use_skill', 'decompose_task']));
      expect(names(shaped)).not.toEqual(expect.arrayContaining([
        'web_search', 'write_file', 'shell_exec', 'create_artifact', 'tenant_custom',
      ]));

      const prompt = shapePromptMessagesForExecution([{
        role: 'system',
        content: '## Available Tools\n\nweb_search, write_file, decompose_task\n\nUse these tools when the user asks.',
      }], shaped);
      expect(String(prompt[0]?.content)).toContain('decompose_task');
      expect(String(prompt[0]?.content)).toContain('use_skill');
      expect(String(prompt.at(-1)?.content)).toContain('Durable plan execution is required');
      expect(String(prompt.at(-1)?.content)).toContain('direct final delivery are blocked');
    });

    it('constrains current-plan follow-ups to persisted plan controls', () => {
      const shaped = shapeToolsForExecution({
        tools: ALL_TOOLS,
        userText: 'Continue the current plan and retry its failed report step.',
        runtimeAdmission: 'plan_control',
      });

      expect(new Set(names(shaped))).toEqual(new Set([
        'use_skill', 'list_tasks', 'get_task', 'read_task_result',
        'repair_task', 'run_task', 'update_task',
      ]));
      expect(names(shaped)).not.toEqual(expect.arrayContaining([
        'decompose_task', 'web_search', 'write_file', 'shell_exec', 'create_artifact',
      ]));
      const prompt = shapePromptMessagesForExecution([{ role: 'system', content: 'You are MOZI.' }], shaped);
      expect(String(prompt.at(-1)?.content)).toContain('existing persisted plan');
      expect(String(prompt.at(-1)?.content)).toContain('Do not create a duplicate plan');
    });

    it('admits only the MOZI scheduler creation tool for a complex recurring workload', () => {
      const userText = '我需要构建一个定时任务，每天中国 A 股收盘后 15 分钟，搜索最新行情并生成 dashboard。';
      const shaped = shapeToolsForExecution({
        tools: ALL_TOOLS,
        userText,
        runtimeAdmission: 'scheduler_control',
      });

      expect(new Set(names(shaped))).toEqual(new Set(['set_cron_task']));
      expect(names(shaped)).not.toEqual(expect.arrayContaining([
        'decompose_task', 'web_search', 'write_file', 'shell_exec', 'create_background_task',
      ]));
      const prompt = shapePromptMessagesForExecution([{ role: 'system', content: 'You are MOZI.' }], shaped);
      expect(String(prompt.at(-1)?.content)).toContain('create only the schedule now');
      expect(String(prompt.at(-1)?.content)).toContain('managed_brain');
      expect(String(prompt.at(-1)?.content)).toContain('Never use crontab');
    });

    it('admits list before cancel when a schedule id must be resolved', () => {
      const shaped = shapeToolsForExecution({
        tools: ALL_TOOLS,
        userText: '取消我的定时任务',
        runtimeAdmission: 'scheduler_control',
      });
      expect(new Set(names(shaped))).toEqual(new Set(['list_cron_tasks', 'cancel_cron_task']));
    });
  });

  it('shapes identically regardless of which model is running', () => {
    // Shaping is a function of the task. DeepSeek and MiniMax were previously
    // named as weak by provider id and given a different surface than everyone
    // else; nothing about the model may change what the Brain can see.
    const userText = 'Fix this repository bug and run tests';
    const deepseek = shapeToolsForExecution({ tools: ALL_TOOLS, userText, provider: 'deepseek', model: 'deepseek-v4-pro' });
    const anthropic = shapeToolsForExecution({ tools: ALL_TOOLS, userText, provider: 'anthropic', model: 'claude-opus-4-8' });
    const unknown = shapeToolsForExecution({ tools: ALL_TOOLS, userText });
    expect(names(deepseek)).toEqual(names(anthropic));
    expect(names(deepseek)).toEqual(names(unknown));
  });

  it('exposes every tool for a general task, for any model', () => {
    // The old rule filtered `general` tasks purely because the model was not
    // judged strong, so ~53 of 64 catalog models silently lost tools nobody
    // had decided to take away.
    const userText = 'Schedule this workflow for tomorrow';
    for (const [provider, model] of [['deepseek', 'deepseek-v4-pro'], ['anthropic', 'claude-opus-4-8'], [undefined, undefined]] as const) {
      const shaped = shapeToolsForExecution({ tools: ALL_TOOLS, userText, provider, model });
      expect(shaped.taskProfile).toBe('general');
      expect(shaped.shapedCount, `${provider ?? 'unknown'} should see every tool`).toBe(ALL_TOOLS.length);
    }
  });

  it('keeps coding tools and removes browser/desktop tools for coding', () => {
    const shaped = shapeToolsForExecution({
      tools: ALL_TOOLS,
      userText: 'Fix this repository bug and run tests',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
    });
    expect(names(shaped)).toEqual(expect.arrayContaining(['read_file', 'edit_file', 'git_diff', 'run_tests', 'shell_exec']));
    expect(names(shaped)).not.toEqual(expect.arrayContaining(['browser_open', 'desktop_click']));
    expect(shaped.shapedCount).toBeLessThan(shaped.originalCount);
    expect(shaped.schemaTokensEstimate).toBeLessThan(Math.ceil(JSON.stringify(ALL_TOOLS).length / 4) * 0.75);
  });

  it('keeps the shell path required by Office skills while removing git and browser', () => {
    const shaped = shapeToolsForExecution({
      tools: ALL_TOOLS,
      userText: '做一个 Excel 表格并保存到本地',
      provider: 'minimax',
      model: 'MiniMax-M3',
    });
    expect(names(shaped)).toEqual(expect.arrayContaining(['use_skill', 'shell_exec', 'write_file', 'create_artifact']));
    expect(names(shaped)).not.toEqual(expect.arrayContaining(['git_commit', 'browser_open']));
  });

  it('never removes tenant dynamic tools', () => {
    const dynamic = { type: 'function' as const, function: { name: 'tenant_custom', description: 'custom', parameters: { type: 'object' } } };
    const shaped = shapeToolsForExecution({
      tools: [...ALL_TOOLS, dynamic],
      userText: 'What is this?',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
    });
    expect(names(shaped)).toContain('tenant_custom');
  });

  it('never removes artifact tools when a simple-looking request explicitly asks for HTML', () => {
    const shaped = shapeToolsForExecution({
      tools: ALL_TOOLS,
      userText: '给我一个 HTML，做一个？',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
    });
    expect(shaped.taskProfile).toBe('simple');
    expect(names(shaped)).toEqual(expect.arrayContaining(['create_artifact', 'update_artifact']));
  });

  it('keeps computer-use tools for desktop tasks and control-plane tools for general tasks', () => {
    const desktop = shapeToolsForExecution({
      tools: ALL_TOOLS,
      userText: 'Open the desktop app and click the login button',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
    });
    expect(names(desktop)).toEqual(expect.arrayContaining(['desktop_launch_app', 'desktop_click', 'desktop_screenshot']));

    const general = shapeToolsForExecution({
      tools: ALL_TOOLS,
      userText: 'Schedule this workflow for tomorrow',
      provider: 'minimax',
      model: 'MiniMax-M3',
    });
    expect(names(general)).toEqual(expect.arrayContaining(['set_cron_task', 'connector_execute', 'install_skill']));
  });

  it('aligns the prompt tool list without deleting capability guidance', () => {
    // The tool list is rewritten to match what was exposed, but the sections
    // describing capabilities stay. Deleting "Task Decomposition" for models
    // judged weak is why DeepSeek never planned with DAGs: it still held
    // decompose_task and had been told nothing about when to use it.
    const shapedTools = shapeToolsForExecution({
      tools: ALL_TOOLS,
      userText: 'Research the latest release',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
    });
    const [system, policy] = shapePromptMessagesForExecution([{
      role: 'system',
      content: [
        'Core safety.',
        '## Visual Output & Aesthetics\nvisual tutorial',
        '## Task Decomposition\ndecomposition tutorial',
        '## Persistent Tasks\ntask tutorial',
        '## Available Tools\n\nread_file, shell_exec, desktop_click\n\nUse these tools when the user asks.',
      ].join('\n'),
    }], shapedTools);
    // Tool list still reflects reality: desktop_click is not exposed for research.
    expect(String(system.content)).not.toContain('desktop_click');
    expect(String(system.content)).toContain('Task Decomposition');
    expect(String(system.content)).toContain('Persistent Tasks');
    expect(String(system.content)).toContain('Visual Output & Aesthetics');
    // The policy states the surface; it does not coach the model on how to think.
    expect(String(policy.content)).toContain('research');
    expect(String(policy.content)).not.toContain('weak_tool_use');
    expect(String(policy.content)).not.toContain('Prefer one valid tool call');
  });

  it('leaves the whole prompt intact for a general task', () => {
    const shapedTools = shapeToolsForExecution({
      tools: ALL_TOOLS,
      userText: 'Schedule this workflow for tomorrow',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
    });
    const shaped = shapePromptMessagesForExecution([{
      role: 'system',
      content: '## Task Decomposition\ndecomposition tutorial\n\n## Available Tools\n\nread_file\n\nUse these tools when the user asks.',
    }], shapedTools);
    expect(String(shaped[0].content)).toContain('Task Decomposition');
    // No policy message is appended when nothing was narrowed.
    expect(shaped).toHaveLength(1);
  });

  it('rewrites the shared Available Tools section and removes the tenant capability contract on child surfaces', () => {
    const shapedTools = shapeToolsForExecution({
      tools: ALL_TOOLS,
      userText: 'Research the latest release',
    });
    const shaped = shapePromptMessagesForExecution([{
      role: 'system',
      content: [
        '# SOUL.md — Runtime Identity',
        '---',
        '## Available Tools\n\nread_file, desktop_click\n\nUse these tools when the user asks.',
        '---',
        '## Runtime Capability Contract (Authoritative)\n- desktop: enabled',
      ].join('\n\n'),
    }], shapedTools, { childSurface: true });

    const system = String(shaped[0]?.content);
    expect(system).toContain('Use only these currently exposed tools.');
    expect(system).not.toContain('Use these tools when the user asks.');
    expect(system).not.toContain('desktop_click');
    expect(system).not.toContain('Runtime Capability Contract');
    expect(system).toContain('# SOUL.md — Runtime Identity');
  });
});
