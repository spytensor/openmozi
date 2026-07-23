#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { get } from 'node:https';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_NODE_VERSION = '22.21.1';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_DEST = join(ROOT, 'desktop', 'resources', 'node');

function getArg(name, fallback) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return fallback;
}

function normalizePlatform(raw) {
  if (raw === 'darwin' || raw === 'linux') return raw;
  throw new Error(`Unsupported desktop Node platform: ${raw}`);
}

function normalizeArch(raw) {
  if (raw === 'arm64' || raw === 'x64') return raw;
  throw new Error(`Unsupported desktop Node architecture: ${raw}`);
}

function nodeDistName(version, platform, arch) {
  return `node-v${version}-${platform}-${arch}`;
}

function nodeDistUrl(version, platform, arch) {
  return `https://nodejs.org/dist/v${version}/${nodeDistName(version, platform, arch)}.tar.gz`;
}

function shasumsUrl(version) {
  return `https://nodejs.org/dist/v${version}/SHASUMS256.txt`;
}

function fetchText(url) {
  return new Promise((resolveText, reject) => {
    get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`GET ${url} failed with HTTP ${response.statusCode}`));
        response.resume();
        return;
      }
      response.setEncoding('utf8');
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolveText(body));
    }).on('error', reject);
  });
}

function downloadFile(url, destination) {
  return new Promise((resolveDownload, reject) => {
    get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`GET ${url} failed with HTTP ${response.statusCode}`));
        response.resume();
        return;
      }
      const output = createWriteStream(destination);
      pipeline(response, output).then(resolveDownload, reject);
    }).on('error', reject);
  });
}

function expectedSha(shasums, fileName) {
  const line = shasums.split('\n').find((entry) => entry.endsWith(`  ${fileName}`));
  if (!line) throw new Error(`No sha256 entry found for ${fileName}`);
  return line.split(/\s+/)[0];
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function main() {
  const version = getArg('--version', process.env.MOZI_DESKTOP_NODE_VERSION || DEFAULT_NODE_VERSION);
  const platform = normalizePlatform(getArg('--platform', process.env.MOZI_DESKTOP_NODE_PLATFORM || process.platform));
  const arch = normalizeArch(getArg('--arch', process.env.MOZI_DESKTOP_NODE_ARCH || process.arch));
  const dest = resolve(getArg('--dest', process.env.MOZI_DESKTOP_NODE_DEST || DEFAULT_DEST));
  const distName = nodeDistName(version, platform, arch);
  const fileName = `${distName}.tar.gz`;
  const tempDir = await mkdtemp(join(tmpdir(), 'mozi-desktop-node-'));
  const archive = join(tempDir, fileName);

  console.log(`Staging Node v${version} (${platform}-${arch}) for MOZI Desktop`);
  console.log(`Destination: ${dest}`);

  const sums = await fetchText(shasumsUrl(version));
  const expected = expectedSha(sums, fileName);
  await downloadFile(nodeDistUrl(version, platform, arch), archive);
  const actual = sha256(archive);
  if (actual !== expected) {
    throw new Error(`SHA256 mismatch for ${fileName}: expected ${expected}, got ${actual}`);
  }

  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  execFileSync('tar', ['-xzf', archive, '-C', tempDir], { stdio: 'inherit' });
  execFileSync('cp', ['-R', join(tempDir, distName), dest], { stdio: 'inherit' });

  const nodeBin = join(dest, 'bin', 'node');
  if (!existsSync(nodeBin)) {
    throw new Error(`Staged Node binary missing at ${nodeBin}`);
  }
  console.log(`Staged ${basename(nodeBin)} at ${nodeBin}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
