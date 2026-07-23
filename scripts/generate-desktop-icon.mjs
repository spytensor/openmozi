#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = join(root, 'desktop', 'assets', 'icon-master.svg');
const brandMark = join(root, 'desktop', 'assets', 'mozi-mark.png');
const iconset = join(root, 'desktop', 'assets', 'MOZI.iconset');
const output = join(root, 'desktop', 'assets', 'MOZI.icns');
const master = join(iconset, 'icon_512x512@2x.png');

rmSync(iconset, { recursive: true, force: true });
mkdirSync(iconset, { recursive: true });
execFileSync('/usr/bin/sips', ['-s', 'format', 'png', source, '--out', brandMark], { stdio: 'inherit' });
execFileSync('/bin/cp', [brandMark, master]);
execFileSync('/usr/bin/swift', [join(root, 'scripts', 'verify-desktop-icon.swift'), brandMark], { stdio: 'inherit' });

for (const [filename, size] of [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
]) {
  execFileSync('/usr/bin/sips', ['-z', String(size), String(size), master, '--out', join(iconset, filename)], { stdio: 'ignore' });
}

execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', output], { stdio: 'inherit' });
console.log(`Generated ${output}`);
