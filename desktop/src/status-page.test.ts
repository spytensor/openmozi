import { describe, expect, it } from 'vitest';
import { renderStatusPage } from './status-page.js';
import type { DesktopRuntimeState } from './supervisor.js';

function state(overrides: Partial<DesktopRuntimeState> = {}): DesktopRuntimeState {
  return {
    status: 'starting',
    owner: 'desktop',
    url: 'http://127.0.0.1:9210/',
    healthUrl: 'http://127.0.0.1:9210/api/health',
    nodePath: '/app/node',
    entryPath: '/app/runtime/index.js',
    moziHome: '/Users/test/Library/Application Support/MOZI',
    logPath: '/Users/test/Library/Application Support/MOZI/logs/mozi.log',
    checkedAt: '2026-07-11T00:00:00.000Z',
    ...overrides,
  };
}

describe('desktop startup status page', () => {
  it('shows a quiet English startup state without internal diagnostics', () => {
    const html = renderStatusPage(state(), 'en-US');
    expect(html).toContain('Preparing MOZI…');
    expect(html).not.toContain('Health check');
    expect(html).not.toContain('http://127.0.0.1:9210/api/health');
    expect(html).not.toContain('/app/runtime/index.js');
  });

  it('localizes the normal startup state in Chinese', () => {
    const html = renderStatusPage(state(), 'zh-CN');
    expect(html).toContain('正在准备 MOZI…');
    expect(html).toContain('<html lang="zh-CN">');
    expect(html).not.toContain('运行时');
  });

  it('keeps actionable diagnostics behind collapsed technical details on failure', () => {
    const html = renderStatusPage(state({ status: 'failed', error: '<unsafe> failed' }), 'zh-Hans');
    expect(html).toContain('MOZI 暂时无法启动');
    expect(html).toContain('<details>');
    expect(html).toContain('技术详情');
    expect(html).toContain('mozi-action://retry');
    expect(html).toContain('mozi-action://restart');
    expect(html).toContain('mozi-action://open-log');
    expect(html).toContain('&lt;unsafe&gt; failed');
    expect(html).toContain('/app/runtime/index.js');
  });
});
