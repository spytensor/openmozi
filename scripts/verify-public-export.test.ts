import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findPublicExportViolations } from './verify-public-export.mjs';

describe('verify-public-export', () => {
  it('blocks private paths, runtime data, and internal project names', () => {
    const files = ['docs/private.md', 'data.pre-v2.bak/runtime.log'];
    const ownerPath = `/Users/${['zhu', 'chaojie'].join('')}/codes/project`;
    const ownerLinuxPath = `/home/${['chaojie', 'zhu'].join('')}/workspace/project`;
    const privateProject = ['Core', 'Room'].join('');
    const content = new Map([
      ['docs/private.md', `Project ${privateProject} lives at ${ownerPath} and ${ownerLinuxPath}`],
      ['data.pre-v2.bak/runtime.log', 'runtime'],
    ]);

    expect(findPublicExportViolations(files, (path) => content.get(path) ?? '')).toEqual([
      'docs/private.md: owner-local path',
      'docs/private.md: owner Linux path',
      'docs/private.md: private project name',
      'data.pre-v2.bak/runtime.log: forbidden tracked path',
    ]);
  });

  it('allows synthetic example paths and the environment template', () => {
    const files = ['docs/public.md', '.env.example'];
    const content = new Map([
      ['docs/public.md', 'Clone into /Users/example/projects/OpenMozi'],
      ['.env.example', 'OPENAI_API_KEY=your-key-here'],
    ]);

    expect(findPublicExportViolations(files, (path) => content.get(path) ?? '')).toEqual([]);
  });

  it('blocks Telegram bot tokens even when the generic secret scanner misses them', () => {
    const token = ['1234567890', ['synthetic', 'telegram', 'credential', 'fixture', 'only'].join('_')].join(':');
    expect(findPublicExportViolations(['scripts/test-live.mjs'], () => `const token = '${token}'`)).toEqual([
      'scripts/test-live.mjs: exposed Telegram bot token',
    ]);
  });

  it('keeps the public license contract consistent and ships notices in the Mac app', () => {
    for (const path of ['package.json', 'ui/package.json', 'desktop/package.json']) {
      const manifest = JSON.parse(readFileSync(path, 'utf8')) as { license?: string };
      expect(manifest.license, path).toBe('MIT');
    }

    expect(existsSync('THIRD_PARTY_NOTICES.md')).toBe(true);
    expect(existsSync('third_party/licenses/codesandbox-nodebox-SUL-1.0.txt')).toBe(true);
    expect(existsSync('third_party/licenses/lobehub-ui-MIT.txt')).toBe(true);

    const desktop = JSON.parse(readFileSync('desktop/package.json', 'utf8')) as {
      build: { extraResources: Array<{ from: string; to: string }> };
    };
    expect(desktop.build.extraResources).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: '../LICENSE', to: 'licenses/OpenMozi-MIT.txt' }),
      expect.objectContaining({ from: '../THIRD_PARTY_NOTICES.md', to: 'licenses/THIRD_PARTY_NOTICES.md' }),
      expect.objectContaining({ from: '../third_party/licenses', to: 'licenses/third-party' }),
      expect.objectContaining({ from: 'resources/python', to: 'python' }),
    ]));
  });
});
