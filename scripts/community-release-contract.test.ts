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
    expect(desktop.scripts['dist:mac']).toContain('--publish never');

    const release = readFileSync('scripts/release.mjs', 'utf8');
    expect(release).toContain("'--verify-tag'");
    expect(release).toContain('unsigned macOS prerelease');
    expect(release).toContain('xattr -dr com.apple.quarantine /Applications/MOZI.app');
    expect(release).toContain('scripts/release-supply-chain.mjs');
    expect(release).toContain('openmozi-${version}-SHA256SUMS.txt');
    expect(release).toContain("'desktop:test:packaged'");
    expect(release).not.toContain('scripts/public-export.config.json');
    expect(release).toContain("'--skip-commit-scan'");

    const supplyChain = readFileSync('.github/workflows/release-supply-chain.yml', 'utf8');
    expect(supplyChain).toContain("tr '[:upper:]' '[:lower:]'");
    expect(supplyChain).toContain('CSC_IDENTITY_AUTO_DISCOVERY: "false"');
    expect(supplyChain).toContain('gh release create');
    expect(supplyChain).toContain('openmozi-${{ inputs.version }}-${{ inputs.channel }}-manifest.json');
    expect(supplyChain).not.toContain('ghcr.io/${{ github.repository }}');

    const build = JSON.parse(readFileSync('desktop/package.json', 'utf8')) as {
      build: { artifactName: string; productName: string };
    };
    expect(build.build.artifactName).toBe('openmozi-${version}-${arch}.${ext}');
    expect(build.build.productName).toBe('MOZI');

    for (const readme of ['README.md', 'README.zh-CN.md']) {
      const content = readFileSync(readme, 'utf8');
      expect(content).toContain('https://github.com/spytensor/openmozi/releases');
      expect(content).toContain('xattr -dr com.apple.quarantine /Applications/MOZI.app');
    }
  });

  it('supports an additional Docker root CA without coupling apt and pip layers', () => {
    const dockerfile = readFileSync('Dockerfile', 'utf8');
    const compose = readFileSync('docker-compose.yml', 'utf8');

    expect(dockerfile).toContain('ARG MOZI_EXTRA_CA_CERT_B64=');
    expect(dockerfile).toContain('update-ca-certificates');
    expect(compose).toContain('MOZI_EXTRA_CA_CERT_B64: ${MOZI_EXTRA_CA_CERT_B64:-}');
    expect(dockerfile).toMatch(/rm -rf \/var\/lib\/apt\/lists\/\*\n\n# Keep Python packages[\s\S]+RUN pip3 install/);
  });
});
