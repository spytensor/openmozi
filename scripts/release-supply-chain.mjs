#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const SEMVER_REGEX = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const DIGEST_REGEX = /^sha256:[a-f0-9]{64}$/;
const ROOT = process.cwd();
const PACKAGE_PATHS = ['package.json', 'ui/package.json', 'desktop/package.json'];

function fail(message) {
  console.error(`[release-supply-chain] ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    version: '',
    channel: 'stable',
    commit: '',
    dist: 'desktop/dist',
    out: 'release/mozi-release-manifest.json',
    dockerImage: '',
    dockerDigest: '',
    expectTag: false,
    requireGithubRelease: false,
    requireSigned: false,
    requireNotarized: false,
    requireDockerDigest: false,
    publishable: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i] ?? '';

    if (arg === '--version') {
      options.version = next();
    } else if (arg.startsWith('--version=')) {
      options.version = arg.slice('--version='.length);
    } else if (arg === '--channel') {
      options.channel = next();
    } else if (arg.startsWith('--channel=')) {
      options.channel = arg.slice('--channel='.length);
    } else if (arg === '--commit') {
      options.commit = next();
    } else if (arg.startsWith('--commit=')) {
      options.commit = arg.slice('--commit='.length);
    } else if (arg === '--dist') {
      options.dist = next();
    } else if (arg.startsWith('--dist=')) {
      options.dist = arg.slice('--dist='.length);
    } else if (arg === '--out') {
      options.out = next();
    } else if (arg.startsWith('--out=')) {
      options.out = arg.slice('--out='.length);
    } else if (arg === '--docker-image') {
      options.dockerImage = next();
    } else if (arg.startsWith('--docker-image=')) {
      options.dockerImage = arg.slice('--docker-image='.length);
    } else if (arg === '--docker-digest') {
      options.dockerDigest = next();
    } else if (arg.startsWith('--docker-digest=')) {
      options.dockerDigest = arg.slice('--docker-digest='.length);
    } else if (arg === '--expect-tag') {
      options.expectTag = true;
    } else if (arg === '--require-github-release') {
      options.requireGithubRelease = true;
    } else if (arg === '--require-signed') {
      options.requireSigned = true;
    } else if (arg === '--require-notarized') {
      options.requireNotarized = true;
    } else if (arg === '--require-docker-digest') {
      options.requireDockerDigest = true;
    } else if (arg === '--publishable') {
      options.publishable = true;
      options.requireSigned = true;
      options.requireNotarized = true;
      options.requireDockerDigest = true;
      options.expectTag = true;
      options.requireGithubRelease = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      fail(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log([
    'MOZI release supply-chain verifier',
    '',
    'Usage:',
    '  node scripts/release-supply-chain.mjs --version 2.0.0 --commit <sha>',
    '  node scripts/release-supply-chain.mjs --version 2.0.0 --channel beta --dist desktop/dist --out release/beta.json',
    '  node scripts/release-supply-chain.mjs --version 2.0.0 --publishable --docker-image ghcr.io/org/mozi:2.0.0 --docker-digest sha256:<64hex>',
    '',
    'Publication mode is fail-closed: --publishable requires the git tag, GitHub',
    'Release, signed and notarized macOS artifacts, DMG/ZIP checksums, and an',
    'immutable Docker digest before a manifest can be considered publishable.',
  ].join('\n'));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    encoding: 'utf-8',
    stdio: options.stdio ?? 'pipe',
  });
}

function commandOutput(command, args) {
  const result = run(command, args);
  if (result.status !== 0) return '';
  return (result.stdout ?? '').trim();
}

function requireSemver(version) {
  if (!SEMVER_REGEX.test(version)) fail(`Invalid semver version: ${version}`);
  if (version.includes('+')) fail(`Build metadata is not allowed in release artifact versions: ${version}`);
}

function resolveCommit(input) {
  if (input.trim()) return input.trim();
  const commit = commandOutput('git', ['rev-parse', 'HEAD']);
  return commit || 'unknown';
}

function verifyPackageVersions(version) {
  const packages = [];
  for (const packagePath of PACKAGE_PATHS) {
    const fullPath = resolve(ROOT, packagePath);
    if (!existsSync(fullPath)) continue;
    const pkg = readJson(fullPath);
    packages.push({ path: packagePath, version: pkg.version });
  }
  const mismatch = packages.filter((pkg) => pkg.version !== version);
  if (mismatch.length > 0) {
    fail(`Package versions do not reconcile with ${version}: ${mismatch.map((pkg) => `${pkg.path}=${pkg.version}`).join(', ')}`);
  }
  return packages;
}

function verifyChannel(version, channel) {
  if (channel !== 'stable' && channel !== 'beta') fail(`Invalid release channel: ${channel}`);
  if (channel === 'stable' && version.includes('-')) {
    fail(`Stable channel cannot publish a prerelease version: ${version}`);
  }
}

function verifyGitTag(version, commit) {
  const tagName = `v${version}`;
  const tagCommit = commandOutput('git', ['rev-list', '-n', '1', tagName]);
  if (!tagCommit) fail(`Required release tag is missing: ${tagName}`);
  if (commit !== 'unknown' && !commit.startsWith(tagCommit) && !tagCommit.startsWith(commit)) {
    fail(`Release tag ${tagName} points at ${tagCommit}, not ${commit}`);
  }
  return { name: tagName, commit: tagCommit };
}

function verifyGithubRelease(version) {
  const tagName = `v${version}`;
  const result = run('gh', ['release', 'view', tagName, '--json', 'tagName,url,isDraft,isPrerelease']);
  if (result.status !== 0) {
    fail(`GitHub Release is missing or inaccessible for ${tagName}`);
  }
  const release = JSON.parse(result.stdout);
  if (release.isDraft) fail(`GitHub Release ${tagName} is still a draft`);
  return release;
}

function walkFiles(root) {
  if (!existsSync(root)) return [];
  const entries = readdirSync(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      files.push(...walkFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function walkDirs(root) {
  if (!existsSync(root)) return [];
  const entries = readdirSync(root, { withFileTypes: true });
  const dirs = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (!entry.isDirectory()) continue;
    dirs.push(path);
    if (entry.name !== 'node_modules') dirs.push(...walkDirs(path));
  }
  return dirs;
}

function checksum(path, algorithm, encoding = 'hex') {
  const hash = createHash(algorithm);
  hash.update(readFileSync(path));
  return hash.digest(encoding);
}

function artifactKind(path) {
  const extension = extname(path).toLowerCase();
  if (extension === '.dmg') return 'macos_dmg';
  if (extension === '.zip') return 'macos_zip';
  return null;
}

function collectArtifacts(distPath) {
  const files = walkFiles(distPath);
  return files
    .map((path) => {
      const kind = artifactKind(path);
      if (!kind) return null;
      const stat = statSync(path);
      return {
        kind,
        name: basename(path),
        path: relative(ROOT, path),
        size: stat.size,
        sha256: checksum(path, 'sha256'),
        sha512: checksum(path, 'sha512', 'base64'),
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.path.localeCompare(right.path));
}

function findAppBundles(distPath) {
  return walkDirs(distPath)
    .filter((path) => basename(path) === 'MOZI.app')
    .sort((left, right) => left.localeCompare(right));
}

function readAppBuildInfo(appPath) {
  const buildInfoPath = join(appPath, 'Contents/Resources/mozi/dist/build-info.json');
  if (!existsSync(buildInfoPath)) return null;
  return {
    path: relative(ROOT, buildInfoPath),
    ...readJson(buildInfoPath),
  };
}

function verifyBuildIdentity(appBundles, expected) {
  if (appBundles.length === 0) return [];
  const buildInfos = appBundles.map(readAppBuildInfo).filter(Boolean);
  if (buildInfos.length !== appBundles.length) {
    fail('Every packaged MOZI.app must include Contents/Resources/mozi/dist/build-info.json');
  }
  for (const info of buildInfos) {
    if (info.version !== expected.version) fail(`${info.path} version=${info.version}, expected ${expected.version}`);
    if (expected.commit !== 'unknown' && info.commit !== expected.commit) fail(`${info.path} commit=${info.commit}, expected ${expected.commit}`);
    if (info.channel !== expected.channel) fail(`${info.path} channel=${info.channel}, expected ${expected.channel}`);
    if (info.surface && info.surface !== 'desktop') fail(`${info.path} surface=${info.surface}, expected desktop`);
  }
  return buildInfos;
}

function succeeds(command, args) {
  return run(command, args).status === 0;
}

function verifyMacSigning(appBundles, requireSigned) {
  if (appBundles.length === 0) return { checked: false, signed: false, identities: [] };
  if (process.platform !== 'darwin') {
    if (requireSigned) fail('macOS signing verification requires a macOS runner');
    return { checked: false, signed: false, identities: [] };
  }
  const identities = [];
  const signed = appBundles.every((appPath) => {
    if (!succeeds('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath])) return false;
    const details = run('codesign', ['-dv', '--verbose=4', appPath]);
    const output = `${details.stdout ?? ''}\n${details.stderr ?? ''}`;
    const authority = output.match(/^Authority=(Developer ID Application: .+)$/m)?.[1] ?? '';
    identities.push(authority);
    return details.status === 0 && authority.length > 0;
  });
  if (requireSigned && !signed) fail('macOS app bundle is not signed with a valid Developer ID Application identity');
  return { checked: true, signed, identities };
}

function verifyMacNotarization(artifacts, requireNotarized) {
  const dmgArtifacts = artifacts.filter((artifact) => artifact.kind === 'macos_dmg');
  if (dmgArtifacts.length === 0) return { checked: false, notarized: false };
  if (process.platform !== 'darwin') {
    if (requireNotarized) fail('macOS notarization verification requires a macOS runner');
    return { checked: false, notarized: false };
  }
  const notarized = dmgArtifacts.every((artifact) => succeeds('xcrun', ['stapler', 'validate', resolve(ROOT, artifact.path)]));
  if (requireNotarized && !notarized) fail('macOS DMG is not stapled/notarized');
  return { checked: true, notarized };
}

function verifyDocker(options) {
  if (options.dockerDigest && !DIGEST_REGEX.test(options.dockerDigest)) {
    fail(`Invalid Docker digest: ${options.dockerDigest}`);
  }
  if (options.requireDockerDigest && (!options.dockerImage || !options.dockerDigest)) {
    fail('Publishable releases require immutable Docker image and sha256 digest evidence');
  }
  return options.dockerImage || options.dockerDigest
    ? { image: options.dockerImage || null, digest: options.dockerDigest || null }
    : null;
}

function macReleaseBlockers({ artifacts, signing, notarization }) {
  const blockers = [];
  if (!artifacts.some((artifact) => artifact.kind === 'macos_dmg')) blockers.push('missing_macos_dmg');
  if (!artifacts.some((artifact) => artifact.kind === 'macos_zip')) blockers.push('missing_macos_zip');
  if (!signing.signed) blockers.push('macos_app_not_signed');
  if (!notarization.notarized) blockers.push('macos_dmg_not_notarized');
  return blockers;
}

function releaseBlockers({ macos, docker }) {
  const blockers = [...macos];
  if (!docker?.digest) blockers.push('missing_docker_digest');
  return blockers;
}

function writeManifest(path, manifest) {
  const fullPath = resolve(ROOT, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const version = options.version.trim() || readJson(resolve(ROOT, 'package.json')).version;
  requireSemver(version);
  verifyChannel(version, options.channel);
  const commit = resolveCommit(options.commit);
  const distPath = resolve(ROOT, options.dist);

  const packages = verifyPackageVersions(version);
  const tag = options.expectTag ? verifyGitTag(version, commit) : null;
  const githubRelease = options.requireGithubRelease ? verifyGithubRelease(version) : null;
  const artifacts = collectArtifacts(distPath);
  const appBundles = findAppBundles(distPath);
  const buildIdentity = verifyBuildIdentity(appBundles, { version, commit, channel: options.channel });
  const signing = verifyMacSigning(appBundles, options.requireSigned);
  const notarization = verifyMacNotarization(artifacts, options.requireNotarized);
  const docker = verifyDocker(options);
  const macosBlockers = macReleaseBlockers({ artifacts, signing, notarization });
  const blockers = releaseBlockers({ macos: macosBlockers, docker });
  const publishable = blockers.length === 0;

  if (options.publishable && !publishable) {
    fail(`Release is not publishable: ${blockers.join(', ')}`);
  }

  const manifest = {
    schema_version: 1,
    product: 'MOZI',
    version,
    channel: options.channel,
    commit,
    generated_at: new Date().toISOString(),
    source: {
      tag,
      github_release: githubRelease,
    },
    packages,
    build_identity: buildIdentity,
    artifacts,
    docker,
    macos: {
      app_bundles: appBundles.map((path) => relative(ROOT, path)),
      signing_checked: signing.checked,
      signed: signing.signed,
      signing_identities: signing.identities,
      notarization_checked: notarization.checked,
      notarized: notarization.notarized,
      publishable: macosBlockers.length === 0,
      release_blockers: macosBlockers,
    },
    publishable,
    release_blockers: blockers,
    rollback_notes: [
      'App updates preserve ~/Library/Application Support/MOZI.',
      'SQLite migrations are forward-only; rollback requires restoring the pre-upgrade App Support backup.',
      'Docker rollback uses the prior immutable image digest recorded in the previous release manifest.',
    ],
  };

  writeManifest(options.out, manifest);
  console.log(`[release-supply-chain] wrote ${options.out}`);
  console.log(`[release-supply-chain] publishable=${publishable}${blockers.length ? ` blockers=${blockers.join(',')}` : ''}`);
}

main();
