import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

export function buildDesktopPath(currentPath = '', home = homedir()): string {
  const candidates = [
    join(home, 'miniconda3', 'bin'),
    join(home, 'anaconda3', 'bin'),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    join(home, '.local', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.cargo', 'bin'),
    '/Applications/LibreOffice.app/Contents/MacOS',
    ...currentPath.split(delimiter),
  ];
  return [...new Set(candidates.filter((entry) => entry && existsSync(entry)))].join(delimiter);
}
