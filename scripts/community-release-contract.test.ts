import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('OpenMozi community and release contract', () => {
  it('ships structured contribution entry points without public security disclosure', () => {
    for (const path of [
      '.github/ISSUE_TEMPLATE/config.yml',
      '.github/ISSUE_TEMPLATE/bug-report.yml',
      '.github/ISSUE_TEMPLATE/feature-request.yml',
      '.github/ISSUE_TEMPLATE/documentation.yml',
      '.github/pull_request_template.md',
      'CONTRIBUTING.md',
      'CODE_OF_CONDUCT.md',
      'SUPPORT.md',
    ]) {
      expect(existsSync(path), path).toBe(true);
    }

    const config = readFileSync('.github/ISSUE_TEMPLATE/config.yml', 'utf8');
    expect(config).toContain('blank_issues_enabled: false');
    expect(config).toContain('/security/advisories/new');
    expect(readFileSync('.github/ISSUE_TEMPLATE/bug-report.yml', 'utf8')).toContain('This is not a security vulnerability');
  });

  it('requires GitHub Releases to contain both Mac formats and explicit trust evidence', () => {
    const desktop = JSON.parse(readFileSync('desktop/package.json', 'utf8')) as { scripts: Record<string, string> };
    expect(desktop.scripts['dist:mac']).toContain('--mac dmg zip');

    const release = readFileSync('scripts/release.mjs', 'utf8');
    expect(release).toContain("'--verify-tag'");
    expect(release).toContain('unsigned macOS prerelease');
    expect(release).toContain('scripts/release-supply-chain.mjs');
    expect(release).toContain('OpenMozi-${version}-SHA256SUMS.txt');
    expect(release).toContain("'desktop:test:packaged'");
  });
});
