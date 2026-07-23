#!/usr/bin/env node

import { copyFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = join(root, 'desktop', 'assets', 'mozi-mark.png');
const targets = [join(root, 'ui', 'public', 'mozi-mark.png')];
const check = process.argv.includes('--check');
const canonical = readFileSync(source);

for (const target of targets) {
  if (check) {
    const published = readFileSync(target);
    if (!canonical.equals(published)) {
      throw new Error(`${target} has drifted from ${source}; run node scripts/sync-brand-assets.mjs`);
    }
  } else {
    copyFileSync(source, target);
  }
}

if (check) {
  const avatarSource = readFileSync(join(root, 'ui', 'src', 'components', 'MoziAvatar.tsx'), 'utf8');
  const webEntry = readFileSync(join(root, 'ui', 'index.html'), 'utf8');
  const desktopGenerator = readFileSync(join(root, 'scripts', 'generate-desktop-icon.mjs'), 'utf8');
  if (!avatarSource.includes('src="/mozi-mark.png"') || avatarSource.includes('<svg')) {
    throw new Error('MoziAvatar must render the shared /mozi-mark.png without an inline SVG variant');
  }
  if (!webEntry.includes('href="/mozi-mark.png"')) {
    throw new Error('Web favicon must reference /mozi-mark.png');
  }
  if (!desktopGenerator.includes("'desktop', 'assets', 'icon-master.svg'")) {
    throw new Error('Desktop icon generation must use the canonical icon-master.svg');
  }
}

console.log(check ? 'MOZI brand assets are synchronized.' : 'Synchronized MOZI brand assets.');
