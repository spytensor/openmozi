import { sanitizeDesktopError } from './security.js';
import type { DesktopRuntimeState } from './supervisor.js';

type SupportedLocale = 'en' | 'zh-CN';

const messages = {
  en: {
    documentTitle: 'MOZI',
    starting: 'Preparing MOZI…',
    failedTitle: 'MOZI couldn’t start',
    failedDetail: 'Something prevented MOZI from opening. Try again, or view the technical details if the problem continues.',
    retry: 'Try again',
    restart: 'Restart MOZI',
    details: 'Technical details',
    openLog: 'Open diagnostic log',
    status: 'Status',
    owner: 'Process owner',
    health: 'Health check',
    runtime: 'Application service',
    data: 'App data',
    logs: 'Log file',
    unknownError: 'Unknown startup failure.',
  },
  'zh-CN': {
    documentTitle: 'MOZI',
    starting: '正在准备 MOZI…',
    failedTitle: 'MOZI 暂时无法启动',
    failedDetail: 'MOZI 在打开时遇到了问题。请重试；如果问题持续出现，可以查看技术详情。',
    retry: '重试',
    restart: '重新启动 MOZI',
    details: '技术详情',
    openLog: '打开诊断日志',
    status: '状态',
    owner: '进程归属',
    health: '健康检查',
    runtime: '应用服务',
    data: '应用数据',
    logs: '日志文件',
    unknownError: '未知启动错误。',
  },
} as const;

function supportedLocale(locale: string | undefined): SupportedLocale {
  return locale?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderStatusPage(state: DesktopRuntimeState, locale?: string): string {
  const language = supportedLocale(locale);
  const copy = messages[language];
  const failed = state.status === 'failed';
  const error = escapeHtml(sanitizeDesktopError(state.error ?? copy.unknownError));

  return `<!doctype html>
<html lang="${language}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${copy.documentTitle}</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f6f7f9; color: #17191c; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: radial-gradient(circle at 50% 42%, #ffffff 0, #f6f7f9 56%, #eef1f5 100%); }
    main { width: min(520px, calc(100vw - 48px)); text-align: center; }
    .mark { width: 58px; height: 58px; margin: 0 auto 22px; display: grid; place-items: center; border-radius: 15px; color: #ffffff; background: #202334; box-shadow: 0 16px 36px rgba(17, 24, 39, .18); font-family: "Songti SC", "STSong", serif; font-size: 30px; }
    h1 { margin: 0; font-size: 19px; line-height: 1.4; font-weight: 600; letter-spacing: -.01em; }
    p { max-width: 440px; margin: 10px auto 0; color: #667085; font-size: 14px; line-height: 1.6; }
    .spinner { width: 18px; height: 18px; margin: 20px auto 0; border: 2px solid rgba(31, 41, 55, .12); border-top-color: #596273; border-radius: 50%; animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 1.8s; } }
    nav { display: flex; justify-content: center; flex-wrap: wrap; gap: 10px; margin-top: 24px; }
    a { color: #17191c; border: 1px solid #d7dce3; border-radius: 8px; padding: 9px 14px; text-decoration: none; font-size: 13px; background: rgba(255,255,255,.82); }
    a.primary { color: #fff; background: #202334; border-color: #202334; }
    details { margin: 24px auto 0; border-top: 1px solid rgba(37,35,31,.1); padding-top: 16px; text-align: left; }
    summary { cursor: pointer; width: fit-content; margin: 0 auto; color: #667085; font-size: 12px; }
    .diagnostics { margin-top: 15px; padding: 14px; border: 1px solid #dde1e6; border-radius: 8px; background: rgba(255,255,255,.86); }
    .error { margin: 0 0 12px; color: #7f2d2d; text-align: left; font-size: 12px; overflow-wrap: anywhere; }
    dl { display: grid; grid-template-columns: 112px minmax(0,1fr); gap: 7px 10px; margin: 0; font-size: 11px; }
    dt { color: #8b95a5; } dd { margin: 0; min-width: 0; overflow-wrap: anywhere; color: #4b5565; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .log-link { display: inline-block; margin-top: 13px; background: transparent; }
  </style>
</head>
<body>
  <main>
    <div class="mark" aria-hidden="true">墨</div>
    ${failed ? `
      <h1>${copy.failedTitle}</h1>
      <p>${copy.failedDetail}</p>
      <nav><a class="primary" href="mozi-action://retry">${copy.retry}</a><a href="mozi-action://restart">${copy.restart}</a></nav>
      <details>
        <summary>${copy.details}</summary>
        <div class="diagnostics">
          <p class="error">${error}</p>
          <dl>
            <dt>${copy.status}</dt><dd>${escapeHtml(state.status)}</dd>
            <dt>${copy.owner}</dt><dd>${escapeHtml(state.owner)}</dd>
            <dt>${copy.health}</dt><dd>${escapeHtml(state.healthUrl)}</dd>
            <dt>${copy.runtime}</dt><dd>${escapeHtml(state.entryPath)}</dd>
            <dt>${copy.data}</dt><dd>${escapeHtml(state.moziHome)}</dd>
            <dt>${copy.logs}</dt><dd>${escapeHtml(state.logPath)}</dd>
          </dl>
          <a class="log-link" href="mozi-action://open-log">${copy.openLog}</a>
        </div>
      </details>` : `
      <h1>${copy.starting}</h1>
      <div class="spinner" role="status" aria-label="${copy.starting}"></div>`}
  </main>
</body>
</html>`;
}
