import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const forbiddenPathPatterns = [
  /(^|\/)data\.pre-[^/]+\//i,
  /(^|\/)workspace\/tmp\//i,
  /\.(?:db|sqlite|log|har|pem|key|p12|pfx)$/i,
  /(^|\/)\.env(?:\.|$)/i,
];

const allowedPaths = new Set(['.env.example']);

const ownerAccount = ['zhu', 'chaojie'].join('');
const legacyOwnerAccount = ['chaojie', 'zhu'].join('');
const formerAccount = ['char', 'lie'].join('');
const privateProject = ['Core', 'Room'].join('');
const privateRepository = ['github\\.com', 'spytensor', 'Mozi'].join('/');

const forbiddenTextPatterns = [
  { label: 'owner-local path', pattern: new RegExp(`/Users/(?:${ownerAccount}|${formerAccount})(?:/|\\b)`, 'i') },
  { label: 'owner Linux path', pattern: new RegExp(`/home/(?:${ownerAccount}|${legacyOwnerAccount}|${formerAccount})(?:/|\\b)`, 'i') },
  { label: 'owner machine name', pattern: /MacBook-Pro-[0-9]+\.local/i },
  { label: 'private project name', pattern: new RegExp(privateProject, 'i') },
  { label: 'private repository URL', pattern: new RegExp(`${privateRepository}(?:\\.git|/|\\b)`, 'i') },
  { label: 'exposed Telegram bot token', pattern: /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/ },
];

const binaryExtensions = new Set([
  '.gif', '.icns', '.ico', '.jpeg', '.jpg', '.pdf', '.png', '.pptx', '.webp', '.xlsx', '.docx',
]);

function extensionOf(path) {
  const dot = path.lastIndexOf('.');
  return dot >= 0 ? path.slice(dot).toLowerCase() : '';
}

export function findPublicExportViolations(files, readFile = (path) => readFileSync(path, 'utf8')) {
  const violations = [];

  for (const path of files) {
    if (!allowedPaths.has(path) && forbiddenPathPatterns.some((pattern) => pattern.test(path))) {
      violations.push(`${path}: forbidden tracked path`);
      continue;
    }
    if (binaryExtensions.has(extensionOf(path))) continue;

    let content;
    try {
      content = readFile(path);
    } catch {
      continue;
    }
    for (const { label, pattern } of forbiddenTextPatterns) {
      if (pattern.test(content)) violations.push(`${path}: ${label}`);
    }
  }

  return violations;
}

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // With --exclude-config, files the public-export policy excludes are not
  // checked — the gate then verifies exactly what would be exported, so it is
  // meaningful in the private source repo as well as in the public mirror.
  let files = trackedFiles().filter((path) => existsSync(path));
  const configFlag = process.argv.indexOf('--exclude-config');
  if (configFlag !== -1) {
    // Same matcher the export uses, so the gate's file set can never drift
    // from what export-public.mjs actually publishes.
    const { isExcluded } = await import('./export-public.mjs');
    const { exclude = [] } = JSON.parse(readFileSync(process.argv[configFlag + 1], 'utf8'));
    files = files.filter((path) => !isExcluded(path, exclude));
  }
  const violations = findPublicExportViolations(files);
  if (violations.length > 0) {
    console.error('[public-export] blocked');
    for (const violation of violations) console.error(`- ${violation}`);
    process.exit(1);
  }
  console.log('[public-export] privacy/path check passed');
}
