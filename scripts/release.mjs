#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const SEMVER_REGEX = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const ROOT = process.cwd();
const ROOT_PACKAGE = resolve(ROOT, 'package.json');
const UI_PACKAGE = resolve(ROOT, 'ui', 'package.json');
const DESKTOP_PACKAGE = resolve(ROOT, 'desktop', 'package.json');
const README = resolve(ROOT, 'README.md');
const CHANGELOG = resolve(ROOT, 'CHANGELOG.md');

function fail(message) {
  console.error(`[release] ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: options.stdio ?? 'inherit',
    encoding: 'utf-8',
    env: options.env ?? process.env,
  });
  if (result.status !== 0) {
    const rendered = [command, ...args].join(' ');
    fail(`Command failed: ${rendered}`);
  }
  return result.stdout ?? '';
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function parseArgs(argv) {
  const options = {
    version: '',
    bump: '',
    commit: false,
    tag: false,
    push: false,
    release: false,
    macAssets: false,
    unsigned: false,
    channel: 'stable',
    all: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      continue;
    }
    if (arg === '--version' || arg === '-v') {
      options.version = argv[++i] ?? '';
      continue;
    }
    if (arg.startsWith('--version=')) {
      options.version = arg.slice('--version='.length);
      continue;
    }
    if (arg === '--bump') {
      options.bump = argv[++i] ?? '';
      continue;
    }
    if (arg.startsWith('--bump=')) {
      options.bump = arg.slice('--bump='.length);
      continue;
    }
    if (arg === '--commit') {
      options.commit = true;
      continue;
    }
    if (arg === '--tag') {
      options.tag = true;
      continue;
    }
    if (arg === '--push') {
      options.push = true;
      continue;
    }
    if (arg === '--release') {
      options.release = true;
      continue;
    }
    if (arg === '--mac-assets') {
      options.macAssets = true;
      continue;
    }
    if (arg === '--unsigned') {
      options.unsigned = true;
      continue;
    }
    if (arg === '--channel') {
      options.channel = argv[++i] ?? '';
      continue;
    }
    if (arg.startsWith('--channel=')) {
      options.channel = arg.slice('--channel='.length);
      continue;
    }
    if (arg === '--all') {
      options.all = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    fail(`Unknown argument: ${arg}`);
  }

  if (options.all) {
    options.commit = true;
    options.tag = true;
    options.push = true;
    options.release = true;
    options.macAssets = true;
  }

  if (options.release) options.macAssets = true;
  if (options.unsigned && !options.macAssets) fail('--unsigned requires --mac-assets or --release');
  if (!['stable', 'beta'].includes(options.channel)) fail('--channel must be stable or beta');
  if (options.unsigned) options.channel = 'beta';

  return options;
}

function printHelp() {
  console.log([
    'MOZI release helper',
    '',
    'Usage:',
    '  node scripts/release.mjs --version 1.0.1',
    '  node scripts/release.mjs --bump patch',
    '  node scripts/release.mjs --version 1.0.1 --commit --tag',
    '  node scripts/release.mjs --version 1.0.1 --all --unsigned',
    '',
    'Flags:',
    '  --version <semver>   Explicit target version (e.g. 1.0.0)',
    '  --bump <type>        patch | minor | major (computed from package.json)',
    '  --commit             Create a release commit',
    '  --tag                Create annotated git tag v<version>',
    '  --push               Push commit and tag to origin',
    '  --release            Create a GitHub Release with verified macOS assets',
    '  --mac-assets         Build DMG + ZIP, run packaged smoke, and create checksummed evidence',
    '  --unsigned           Explicitly publish an unsigned prerelease (never presented as stable)',
    '  --channel <name>     stable | beta (default: stable)',
    '  --all                Commit, build/verify assets, tag, push, and publish the GitHub Release',
  ].join('\n'));
}

function bumpVersion(current, bumpType) {
  const match = current.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    fail(`Cannot bump non-standard version: ${current}`);
  }
  let major = Number(match[1]);
  let minor = Number(match[2]);
  let patch = Number(match[3]);

  switch (bumpType) {
    case 'patch':
      patch += 1;
      break;
    case 'minor':
      minor += 1;
      patch = 0;
      break;
    case 'major':
      major += 1;
      minor = 0;
      patch = 0;
      break;
    default:
      fail(`Invalid bump type: ${bumpType} (expected patch|minor|major)`);
  }

  return `${major}.${minor}.${patch}`;
}

function resolveVersion(options) {
  const rootPkg = readJson(ROOT_PACKAGE);
  if (options.version && options.bump) {
    fail('Use either --version or --bump, not both');
  }
  if (options.version) {
    return options.version.trim().replace(/^v/, '');
  }
  if (options.bump) {
    return bumpVersion(rootPkg.version, options.bump);
  }
  fail('Missing target version. Provide --version <semver> or --bump <type>.');
}

function ensureSemver(version) {
  if (!SEMVER_REGEX.test(version)) {
    fail(`Invalid semver version: ${version}`);
  }
}

function compareSemver(left, right) {
  const parse = (value) => {
    const [core, prerelease = ''] = value.split('+')[0].split('-');
    return { core: core.split('.').map(Number), prerelease };
  };
  const a = parse(left);
  const b = parse(right);
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i] ? 1 : -1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease, undefined, { numeric: true });
}

function updateReadmeVersionBadge(version) {
  if (!existsSync(README)) return false;
  const before = readFileSync(README, 'utf-8');
  const after = before
    .replace(/version-v[0-9A-Za-z._-]+-purple\.svg/g, `version-v${version}-purple.svg`)
    .replace(/Version:\s*v[0-9A-Za-z._-]+/g, `Version: v${version}`);
  if (after !== before) {
    writeFileSync(README, after, 'utf-8');
    return true;
  }
  return false;
}

function trimBlankEdges(lines) {
  const copy = [...lines];
  while (copy.length > 0 && copy[0].trim() === '') copy.shift();
  while (copy.length > 0 && copy[copy.length - 1].trim() === '') copy.pop();
  return copy;
}

function findSectionBounds(lines, heading) {
  const start = lines.findIndex((line) => line.startsWith(heading));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## [')) {
      end = i;
      break;
    }
  }
  return { start, end };
}

function buildUnreleasedReset(version) {
  return [
    '## [Unreleased]',
    '',
    '### Added',
    '',
    `- Release queue reset after v${version}; new entries land here.`,
    '',
    '### Changed',
    '',
    '- None yet.',
    '',
    '### Fixed',
    '',
    '- None yet.',
  ];
}

function hasMeaningfulChangelogContent(lines) {
  return lines.some((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('- ')) return false;
    if (/^- None\.?$/i.test(trimmed)) return false;
    if (/^- None yet\.?$/i.test(trimmed)) return false;
    if (/^- Release queue reset after /i.test(trimmed)) return false;
    return true;
  });
}

function upsertChangelog(version) {
  const date = new Date().toISOString().slice(0, 10);
  const heading = `## [v${version}] - ${date}`;
  if (!existsSync(CHANGELOG)) {
    fail('CHANGELOG.md is missing. Create a formatted Unreleased section before cutting a release.');
  }

  const current = readFileSync(CHANGELOG, 'utf-8');
  if (current.includes(heading)) return false;

  const lines = current.split('\n');
  const unreleased = findSectionBounds(lines, '## [Unreleased]');
  if (!unreleased) {
    fail('CHANGELOG.md must contain an ## [Unreleased] section');
  }

  const unreleasedBody = trimBlankEdges(lines.slice(unreleased.start + 1, unreleased.end));
  if (!hasMeaningfulChangelogContent(unreleasedBody)) {
    fail('CHANGELOG Unreleased section has no meaningful formatted release notes');
  }

  const rebuilt = [
    ...lines.slice(0, unreleased.start),
    ...buildUnreleasedReset(version),
    '',
    heading,
    '',
    ...unreleasedBody,
    '',
    ...trimBlankEdges(lines.slice(unreleased.end)),
  ];

  writeFileSync(CHANGELOG, `${rebuilt.join('\n').replace(/\n+$/, '\n')}`, 'utf-8');
  return true;
}

function extractReleaseNotes(version) {
  if (!existsSync(CHANGELOG)) {
    return `Release v${version}`;
  }
  const heading = `## [v${version}]`;
  const lines = readFileSync(CHANGELOG, 'utf-8').split('\n');
  const start = lines.findIndex((line) => line.startsWith(heading));
  if (start === -1) return `Release v${version}`;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## [')) {
      end = i;
      break;
    }
  }
  const notes = lines.slice(start + 1, end).join('\n').trim();
  return notes || `Release v${version}`;
}

function tagExistsLocally(tagName) {
  const result = spawnSync('git', ['rev-parse', '-q', '--verify', `refs/tags/${tagName}`], {
    stdio: 'ignore',
  });
  return result.status === 0;
}

function commandAvailable(command, args = ['--version']) {
  return spawnSync(command, args, { stdio: 'ignore', env: process.env }).status === 0;
}

function findDirectoryNamed(root, name) {
  if (!existsSync(root)) return '';
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory() && entry.name === name) return path;
    if (entry.isDirectory()) {
      const nested = findDirectoryNamed(path, name);
      if (nested) return nested;
    }
  }
  return '';
}

function macDistributionArtifacts(distPath) {
  if (!existsSync(distPath)) return [];
  return readdirSync(distPath)
    .filter((name) => /\.(?:dmg|zip)$/i.test(name))
    .map((name) => join(distPath, name))
    .sort();
}

function ensureMacReleasePreflight(options) {
  if (!options.macAssets) return;
  if (process.platform !== 'darwin') fail('macOS release assets must be built and verified on macOS');
  if (!options.commit) fail('--mac-assets requires --commit so build identity points at an immutable release commit');
  if (options.release && (!options.tag || !options.push)) {
    fail('--release requires --tag and --push so GitHub assets cannot be detached from source identity');
  }

  const status = run('git', ['status', '--porcelain'], { stdio: 'pipe' }).trim();
  if (status) fail('macOS release requires a clean worktree before version changes');

  const gitleaks = process.env.MOZI_GITLEAKS_BIN || 'gitleaks';
  if (!commandAvailable(gitleaks)) {
    fail('Gitleaks is required for release publication. Install it or set MOZI_GITLEAKS_BIN.');
  }
  if (options.release && (!commandAvailable('gh') || spawnSync('gh', ['auth', 'status'], { stdio: 'ignore' }).status !== 0)) {
    fail('Authenticated GitHub CLI is required to publish a Release');
  }

  if (!options.unsigned) {
    const required = ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'];
    const missing = required.filter((name) => !process.env[name]);
    if (missing.length > 0) {
      fail(`Signed release requires Apple credentials (${missing.join(', ')}). Use --unsigned only for an explicitly labeled prerelease.`);
    }
  }
}

function notarizeArtifacts(artifacts) {
  for (const artifact of artifacts) {
    run('xcrun', [
      'notarytool', 'submit', artifact,
      '--apple-id', process.env.APPLE_ID,
      '--password', process.env.APPLE_APP_SPECIFIC_PASSWORD,
      '--team-id', process.env.APPLE_TEAM_ID,
      '--wait',
    ]);
  }
  for (const dmg of artifacts.filter((path) => path.toLowerCase().endsWith('.dmg'))) {
    run('xcrun', ['stapler', 'staple', dmg]);
    run('xcrun', ['stapler', 'validate', dmg]);
  }
}

function buildMacReleaseAssets(version, channel, unsigned) {
  const commit = run('git', ['rev-parse', 'HEAD'], { stdio: 'pipe' }).trim();
  const distPath = resolve(ROOT, 'desktop', 'dist');
  rmSync(distPath, { recursive: true, force: true });

  run('pnpm', ['verify:public-export']);
  const gitleaks = process.env.MOZI_GITLEAKS_BIN || 'gitleaks';
  run(gitleaks, ['dir', '.', '--no-banner', '--redact', '--exit-code', '1']);

  const buildEnv = {
    ...process.env,
    MOZI_BUILD_VERSION: version,
    MOZI_BUILD_COMMIT: commit,
    MOZI_BUILD_TIME: new Date().toISOString(),
    MOZI_RELEASE_CHANNEL: channel,
    ...(unsigned ? { CSC_IDENTITY_AUTO_DISCOVERY: 'false' } : {}),
  };
  run('pnpm', ['desktop:dist:mac'], { env: buildEnv });

  const appPath = findDirectoryNamed(distPath, 'MOZI.app');
  if (!appPath) fail('desktop:dist:mac did not produce MOZI.app');
  run('pnpm', ['desktop:test:packaged', '--', '--app', appPath]);

  const artifacts = macDistributionArtifacts(distPath);
  if (!artifacts.some((path) => path.endsWith('.dmg')) || !artifacts.some((path) => path.endsWith('.zip'))) {
    fail('desktop:dist:mac must produce both DMG and ZIP artifacts');
  }
  if (!unsigned) notarizeArtifacts(artifacts);

  const manifestPath = join(distPath, `OpenMozi-${version}-${channel}-manifest.json`);
  const manifestArgs = [
    'scripts/release-supply-chain.mjs',
    '--version', version,
    '--commit', commit,
    '--channel', channel,
    '--dist', 'desktop/dist',
    '--out', manifestPath,
    ...(!unsigned ? ['--require-signed', '--require-notarized'] : []),
  ];
  run(process.execPath, manifestArgs);

  const manifest = readJson(manifestPath);
  const releaseArtifacts = manifest.artifacts ?? [];
  const checksumPath = join(distPath, `OpenMozi-${version}-SHA256SUMS.txt`);
  writeFileSync(
    checksumPath,
    `${releaseArtifacts.map((artifact) => `${artifact.sha256}  ${artifact.name}`).join('\n')}\n`,
    'utf-8',
  );

  const notesPath = join(distPath, `OpenMozi-${version}-release-notes.md`);
  const trustNotice = unsigned
    ? '> **Unsigned macOS prerelease:** this build is not signed or notarized by Apple. Verify the published SHA-256 checksums before installing.\n\n'
    : '> **Verified macOS release:** the manifest records Developer ID signing and Apple notarization evidence.\n\n';
  writeFileSync(notesPath, `${trustNotice}${extractReleaseNotes(version)}\n`, 'utf-8');

  return {
    assets: [...artifacts, manifestPath, checksumPath],
    notesPath,
    prerelease: unsigned || channel === 'beta',
    title: unsigned ? `v${version} (unsigned macOS prerelease)` : `v${version}`,
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  ensureMacReleasePreflight(options);
  const version = resolveVersion(options);
  ensureSemver(version);
  const tagName = `v${version}`;

  const changedFiles = [];

  const rootPkg = readJson(ROOT_PACKAGE);
  const versionedPackages = [
    ['package.json', rootPkg],
    ...(existsSync(UI_PACKAGE) ? [['ui/package.json', readJson(UI_PACKAGE)]] : []),
    ...(existsSync(DESKTOP_PACKAGE) ? [['desktop/package.json', readJson(DESKTOP_PACKAGE)]] : []),
  ];
  const currentVersions = new Set(versionedPackages.map(([, pkg]) => pkg.version));
  if (currentVersions.size !== 1) {
    fail(`Versioned packages are out of sync: ${versionedPackages.map(([path, pkg]) => `${path}=${pkg.version}`).join(', ')}`);
  }
  if (compareSemver(version, rootPkg.version) < 0) {
    fail(`Version regression is not allowed: ${rootPkg.version} -> ${version}`);
  }
  if (rootPkg.version !== version) {
    rootPkg.version = version;
    writeJson(ROOT_PACKAGE, rootPkg);
    changedFiles.push('package.json');
  }

  if (existsSync(UI_PACKAGE)) {
    const uiPkg = readJson(UI_PACKAGE);
    if (uiPkg.version !== version) {
      uiPkg.version = version;
      writeJson(UI_PACKAGE, uiPkg);
      changedFiles.push('ui/package.json');
    }
  }

  if (existsSync(DESKTOP_PACKAGE)) {
    const desktopPkg = readJson(DESKTOP_PACKAGE);
    if (desktopPkg.version !== version) {
      desktopPkg.version = version;
      writeJson(DESKTOP_PACKAGE, desktopPkg);
      changedFiles.push('desktop/package.json');
    }
  }

  if (updateReadmeVersionBadge(version)) {
    changedFiles.push('README.md');
  }

  if (upsertChangelog(version)) {
    changedFiles.push('CHANGELOG.md');
  }

  console.log(`[release] target version: ${version}`);
  if (changedFiles.length > 0) {
    console.log(`[release] updated: ${changedFiles.join(', ')}`);
  } else {
    console.log('[release] no file updates required');
  }

  if (!(options.commit || options.tag || options.push || options.release)) {
    console.log('[release] file update complete (no git actions requested)');
    return;
  }

  if (changedFiles.length > 0) {
    run('git', ['add', ...changedFiles]);
  }

  if (options.commit) {
    const hasStaged = run('git', ['diff', '--cached', '--name-only'], { stdio: 'pipe' }).trim().length > 0;
    if (hasStaged) {
      run('git', ['commit', '-m', `chore(release): v${version}`, '-m', 'Co-authored-by: Mozi <MoziAI-co@users.noreply.github.com>']);
    } else {
      console.log('[release] skip commit: no staged changes');
    }
  }

  let macRelease = null;
  if (options.macAssets) {
    const trackedStatus = run('git', ['status', '--porcelain', '--untracked-files=no'], { stdio: 'pipe' }).trim();
    if (trackedStatus) fail('Release commit did not leave a clean tracked worktree');
    macRelease = buildMacReleaseAssets(version, options.channel, options.unsigned);
  }

  if (options.tag) {
    if (tagExistsLocally(tagName)) {
      fail(`Tag already exists locally: ${tagName}`);
    }
    run('git', ['tag', '-a', tagName, '-m', `Release ${tagName}`]);
  }

  if (options.push) {
    run('git', ['push', 'origin', 'HEAD']);
    if (options.tag) {
      run('git', ['push', 'origin', tagName]);
    }
  }

  if (options.release) {
    if (!macRelease) fail('GitHub Release requires verified macOS assets');
    const releaseArgs = [
      'release', 'create', tagName,
      ...macRelease.assets,
      '--title', macRelease.title,
      '--notes-file', macRelease.notesPath,
      '--verify-tag',
      ...(macRelease.prerelease ? ['--prerelease'] : []),
    ];
    run('gh', releaseArgs);
  }

  console.log(`[release] completed: ${tagName}`);
}

main();
