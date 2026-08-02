import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hasPrivateMarker, isExcluded } from './export-public.mjs';

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
// Assembled from fragments for the same reason as the names above: this file
// enumerates the words it forbids, so it must not contain them literally.
const privateWord = ['inter', 'nal'].join('');
const privateProduct = ['MO', 'ZI'].join('');

const forbiddenTextPatterns = [
  { label: 'owner-local path', pattern: new RegExp(`/Users/(?:${ownerAccount}|${formerAccount})(?:/|\\b)`, 'i') },
  { label: 'owner Linux path', pattern: new RegExp(`/home/(?:${ownerAccount}|${legacyOwnerAccount}|${formerAccount})(?:/|\\b)`, 'i') },
  { label: 'owner machine name', pattern: /MacBook-Pro-[0-9]+\.local/i },
  { label: 'private project name', pattern: new RegExp(privateProject, 'i') },
  { label: 'private repository URL', pattern: new RegExp(`${privateRepository}(?:\\.git|/|\\b)`, 'i') },
  // The HTTPS form above misses the two ways the same private repo is usually
  // written: an SSH remote and an api.github.com path.
  { label: 'private repository SSH remote', pattern: new RegExp(`git@github\\.com:spytensor/Mozi(?:\\.git|\\b)`, 'i') },
  { label: 'private repository API URL', pattern: new RegExp(`api\\.github\\.com/repos/spytensor/Mozi(?:/|\\b)`, 'i') },
  { label: 'exposed Telegram bot token', pattern: /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/ },
  // Local assistant tooling writes per-directory scratch files holding session
  // ids and session titles from the operator's own machine. 43 of them reached
  // the public repository before anything checked for this, because they are
  // ordinary tracked files in ordinary paths — only their content gives them
  // away. The exporter drops them; this is the backstop for when it does not.
  {
    label: 'local assistant session context',
    // Assembled from fragments for the same reason as the patterns below: a
    // literal here would make this file match itself on every scan.
    pattern: new RegExp(`<${['claude', 'mem', 'context'].join('-')}>`, 'i'),
  },
  // The published tree must not describe itself in terms of the upstream one:
  // that project's version numbers and commit shas expose its release cadence
  // and mean nothing to a reader here, who owns a separate version line.
  // Patterns are assembled from fragments so this file does not trip itself.
  {
    label: 'upstream tree reference',
    pattern: new RegExp(`\\b${privateWord}\\s+(?:${privateProduct}|tree|snapshot|repo(?:sitory)?)\\b`, 'i'),
  },
  {
    label: 'upstream mirror wording',
    pattern: new RegExp(`\\bmirrors?\\s+(?:the\\s+)?${privateWord}\\b`, 'i'),
  },
  {
    label: 'upstream version reference',
    pattern: new RegExp(`\\b${privateProduct}\\s+v?2\\.\\d+\\.\\d+`, 'i'),
  },
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
    for (const [index, line] of content.split('\n').entries()) {
      // Terminators cover markdown too (backtick/asterisk/underscore/pipe/bang):
      // the canonical URL written in inline code or bold must not be misread as
      // a slug ending in those characters.
      for (const match of line.matchAll(/github\.com\/spytensor\/([^/\\\s?#)"'<>\]`*_|!]+)/g)) {
        const slug = match[1].replace(/[.,;:]+$/, '').replace(/\.git$/, '');
        // `&lt;slug&gt;` and friends are an escaped placeholder in generated
        // HTML, not a repository name — matching them reports a violation that
        // cannot be fixed by renaming anything.
        if (slug.startsWith('&')) continue;
        if (slug !== 'openmozi') {
          violations.push(`${path}:${index + 1}: non-canonical public repository slug "${slug}" (expected "openmozi")`);
        }
      }
    }
  }

  return violations;
}

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

export function filterSourceExportFiles(files, config, readFile = (path) => readFileSync(path, 'utf8')) {
  const { exclude = [], excludeContaining = [] } = config;
  return files.filter((path) => {
    if (isExcluded(path, exclude)) return false;
    if (excludeContaining.length === 0) return true;
    try {
      return !hasPrivateMarker(readFile(path), excludeContaining);
    } catch {
      return true;
    }
  });
}

/**
 * Commit messages are published just as loudly as file contents, and nothing
 * used to check them: the leak that motivated this scan lived entirely in a
 * commit subject the export tooling generated. Scans the messages that are not
 * yet on the upstream branch, so the check is about what is being added.
 */
export function findCommitMessageViolations(messages) {
  const violations = [];
  for (const { sha, message } of messages) {
    for (const { label, pattern } of forbiddenTextPatterns) {
      if (pattern.test(message)) violations.push(`commit ${sha}: ${label} in commit message`);
    }
  }
  return violations;
}

function unpushedCommitMessages() {
  let range;
  try {
    const upstream = execFileSync('git', ['rev-parse', '--abbrev-ref', '@{upstream}'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    range = `${upstream}..HEAD`;
  } catch {
    // No upstream (fresh clone of the public tree, or a detached checkout):
    // check every commit rather than silently checking none.
    range = 'HEAD';
  }
  const raw = execFileSync('git', ['log', range, '--format=%H%x00%B%x1e'], { encoding: 'utf8' });
  return raw
    .split('\x1e')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [sha, message] = entry.split('\x00');
      return { sha: sha.slice(0, 8), message: message ?? '' };
    });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // With --exclude-config, files the public-export policy excludes are not
  // checked — the gate then verifies exactly what would be exported, so it is
  // meaningful in the private source repo as well as in the public mirror.
  let files = trackedFiles().filter((path) => existsSync(path));
  const configFlag = process.argv.indexOf('--exclude-config');
  if (configFlag !== -1) {
    // Same path and content matchers the export uses, so the gate verifies the
    // exact file set export-public.mjs would publish.
    const config = JSON.parse(readFileSync(process.argv[configFlag + 1], 'utf8'));
    files = filterSourceExportFiles(files, config);
  }
  const violations = findPublicExportViolations(files);
  // `--skip-commit-scan` exists for the source repository, whose own history
  // legitimately discusses the export machinery. In the published tree the
  // scan always runs.
  if (!process.argv.includes('--skip-commit-scan')) {
    violations.push(...findCommitMessageViolations(unpushedCommitMessages()));
  }
  if (violations.length > 0) {
    console.error('[public-export] blocked');
    for (const violation of violations) console.error(`- ${violation}`);
    process.exit(1);
  }
  console.log('[public-export] privacy/path + commit-message check passed');
}
