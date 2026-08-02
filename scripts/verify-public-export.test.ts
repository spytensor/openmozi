import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  filterSourceExportFiles,
  findCommitMessageViolations,
  findPublicExportViolations,
} from './verify-public-export.mjs';

describe('verify-public-export', () => {
  it('uses the export path and content exclusions in source-repository mode', () => {
    const marker = `<${['claude', 'mem', 'context'].join('-')}>`;
    const content = new Map([
      ['README.md', '# OpenMozi'],
      ['IMPLEMENTATION.md', 'private design'],
      ['src/CLAUDE.md', marker],
    ]);

    expect(filterSourceExportFiles(
      [...content.keys()],
      { exclude: ['IMPLEMENTATION.md'], excludeContaining: [marker] },
      (path) => content.get(path) ?? '',
    )).toEqual(['README.md']);
  });

  it('blocks per-directory context files written by local assistant tooling', () => {
    // 40 of these reached the public repository before anything checked. They
    // are ordinary tracked markdown in ordinary paths — only their content, a
    // table of session ids and session titles from the operator's machine,
    // gives them away. The marker is assembled from fragments so neither the
    // gate nor this test matches itself.
    const marker = `<${['claude', 'mem', 'context'].join('-')}>`;
    const body = `${marker}\n# Recent Activity\n\n| ID | Title |\n| #2642 | Some session |\n`;
    expect(findPublicExportViolations(['src/CLAUDE.md'], () => body)).toEqual([
      'src/CLAUDE.md: local assistant session context',
    ]);
    // A hand-written CLAUDE.md carrying real project instructions still ships.
    expect(findPublicExportViolations(['CLAUDE.md'], () => '# Instructions\n\nBuild with pnpm.')).toEqual([]);
  });

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

  it('requires the exact canonical public repository slug', () => {
    const wrongRepository = ['https://github.com', 'spytensor', 'OpenMozi.git'].join('/');
    expect(findPublicExportViolations(
      ['dist/README.md'],
      () => `first line\n${wrongRepository}\n`,
    )).toEqual([
      'dist/README.md:2: non-canonical public repository slug "OpenMozi" (expected "openmozi")',
    ]);

    expect(findPublicExportViolations(
      ['dist/README.md'],
      () => 'https://github.com/spytensor/openmozi.git\nhttps://github.com/spytensor/openmozi/issues\n',
    )).toEqual([]);
  });

  it('accepts the canonical slug inside markdown emphasis, code spans and tables', () => {
    // Terminator-class regression: `openmozi\`` / `openmozi**` / `openmozi|`
    // must not be read as the slug, or writing the correct URL in inline code
    // would block the export.
    expect(findPublicExportViolations(
      ['dist/README.md'],
      () => [
        '`https://github.com/spytensor/openmozi`',
        '**https://github.com/spytensor/openmozi**',
        '| https://github.com/spytensor/openmozi | cell |',
        '_https://github.com/spytensor/openmozi_',
        'See https://github.com/spytensor/openmozi!',
      ].join('\n'),
    )).toEqual([]);
  });

  it('rejects upstream tree references, mirror wording, and upstream version numbers', () => {
    // The export tooling itself used to name the upstream project, its version
    // and its commit sha in the published commit message, and the published
    // CHANGELOG described itself the same way. None of that means anything to
    // a reader there, and it exposes the upstream release cadence.
    // Fixtures are assembled from fragments so this test file does not itself
    // trip the gate it is testing — the same idiom the gate uses.
    const upstreamWord = ['inter', 'nal'].join('');
    const product = ['MO', 'ZI'].join('');
    const cases: Array<[string, string]> = [
      [`Mirrors ${upstreamWord} ${product} v2.15.0 (854ec4a0).\n`, 'upstream tree reference'],
      [`This tree mirrors the ${upstreamWord} repository.\n`, 'upstream tree reference'],
      [`Cut from ${product} v2.13.1.\n`, 'upstream version reference'],
    ];
    for (const [content, label] of cases) {
      expect(findPublicExportViolations(['dist/CHANGELOG.md'], () => content), content)
        .toContain(`dist/CHANGELOG.md: ${label}`);
    }

    // Public-facing release prose must stay clean.
    expect(findPublicExportViolations(
      ['dist/CHANGELOG.md'],
      () => '## [v1.1.0]\n\nAdds user-defined agents and Azure OpenAI support.\n',
    )).toEqual([]);
  });

  it('scans commit messages, which are published as loudly as file contents', () => {
    // The real incident: the export tooling generated exactly this subject and
    // nothing checked it, because the gate only ever read tracked files.
    const upstreamWord = ['inter', 'nal'].join('');
    const product = ['MO', 'ZI'].join('');
    expect(findCommitMessageViolations([
      { sha: 'deadbeef', message: `sync: mirror ${upstreamWord} ${product} v2.15.0 (854ec4a0)\n` },
    ])).toEqual([
      'commit deadbeef: upstream tree reference in commit message',
      'commit deadbeef: upstream mirror wording in commit message',
      'commit deadbeef: upstream version reference in commit message',
    ]);

    expect(findCommitMessageViolations([
      { sha: 'cafe1234', message: 'sync: update public tree for v1.1.0\n\nAdds Azure OpenAI support.\n' },
    ])).toEqual([]);
  });

  it('rejects the private repository in its SSH and API forms, not just as an https URL', () => {
    const sshRemote = ['git@github.com:spytensor', 'Mozi.git'].join('/');
    expect(findPublicExportViolations(['dist/setup.md'], () => `${sshRemote}\n`))
      .toEqual(['dist/setup.md: private repository SSH remote']);

    const apiUrl = ['https://api.github.com/repos/spytensor', 'Mozi/releases'].join('/');
    expect(findPublicExportViolations(['dist/setup.md'], () => `${apiUrl}\n`))
      .toEqual(['dist/setup.md: private repository API URL']);
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
