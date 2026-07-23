#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

export const PROMPT_FILES = [
  'src/templates/SOUL.md',
  'src/templates/AGENTS.md',
];

const CHANGELOG_FILE = 'CHANGELOG.md';
const RUNTIME_ROOTS = [
  'src/core/',
  'src/gateway/',
  'src/tools/',
  'src/tel/',
  'src/memory/',
  'src/observer/',
  'src/tenants/',
  'src/capabilities/',
  'src/agents/',
  'src/onboarding/',
  'src/mcp/',
  'src/scheduler/',
  'src/watchdog/',
  'src/security/',
  'src/channels/',
  'src/runtime/',
  'src/progress/',
];

/**
 * Files that decide what the system prompt *claims*.
 *
 * The prompt states two things it does not itself know: the tool list
 * (`## Available Tools`, rendered from the registry) and the capability summary
 * (rendered from the manifest). `system-prompt.ts` assembles them and
 * `tool-shaping.ts` rewrites them per turn. Change any of these and the prompt
 * can start lying; change anything else and it cannot.
 *
 * This is the gate's whole point — §7's "prompt text is policy, not execution"
 * only means something if the policy still matches the runtime. Requiring a
 * prompt edit for every file under RUNTIME_ROOTS did not serve that: a fix to
 * timeline persistence or websocket transport has no prompt implication, so the
 * gate fired for a reason that could not be satisfied honestly, and the only
 * ways past it were a cosmetic doc edit or the bypass. A check that cannot tell
 * "you changed what the prompt promises" from "you fixed a persistence detail"
 * carries no signal, and one that is always red trains everyone to route around
 * it — the same failure that got the complex-task gate removed (CONSTITUTION §14).
 *
 * Note `definitions.ts` is only a barrel: `ALL_TOOLS` spreads SHELL_TOOLS,
 * FS_TOOLS and six more from `*-tools.ts` leaves, and the prompt actually renders
 * `getAllRegisteredTools` out of `dynamic-registry.ts`. Naming the barrel alone
 * would have made the gate silent for the most common drift there is — adding a
 * tool to an existing category never touches it. Hence the pattern below.
 */
export const PROMPT_SURFACE_FILES = [
  'src/core/capability-manifest.ts',
  'src/tools/definitions.ts',
  'src/tools/dynamic-registry.ts',
  'src/system-prompt.ts',
  'src/tools/tool-shaping.ts',
];

/** Where individual tool declarations live: `ALL_TOOLS` spreads every one of these. */
const TOOL_DECLARATION_PATTERN = /^src\/tools\/[a-z0-9-]+-tools\.ts$/;

export function isRuntimeFeatureFile(file) {
  if (!file || typeof file !== 'string') return false;
  if (!file.startsWith('src/')) return false;
  if (file.startsWith('src/templates/')) return false;
  if (file.endsWith('.test.ts')) return false;
  return RUNTIME_ROOTS.some(prefix => file.startsWith(prefix));
}

/** Whether a change can make the prompt's own claims untrue. */
export function isPromptSurfaceFile(file) {
  if (!file || typeof file !== 'string') return false;
  if (file.endsWith('.test.ts')) return false;
  return PROMPT_SURFACE_FILES.includes(file) || TOOL_DECLARATION_PATTERN.test(file);
}

export function evaluatePromptContract(changedFiles) {
  const files = Array.isArray(changedFiles) ? changedFiles : [];
  const runtimeFeatureFiles = files.filter(isRuntimeFeatureFile);
  const promptSurfaceFiles = files.filter(isPromptSurfaceFile);
  const promptTouched = files.some(file => PROMPT_FILES.includes(file));
  const changelogTouched = files.includes(CHANGELOG_FILE);

  const errors = [];
  if (promptSurfaceFiles.length > 0 && !promptTouched) {
    errors.push(
      `Files that decide what the prompt claims changed (${promptSurfaceFiles.join(', ')}), `
      + 'but prompt templates were not updated (src/templates/SOUL.md or src/templates/AGENTS.md). '
      + 'Check the prompt still tells the truth; if it does, say so in the commit and touch nothing.',
    );
  }
  if (runtimeFeatureFiles.length > 0 && !changelogTouched) {
    errors.push('Runtime feature files changed, but CHANGELOG.md was not updated.');
  }

  return {
    ok: errors.length === 0,
    files,
    runtimeFeatureFiles,
    promptSurfaceFiles,
    promptTouched,
    changelogTouched,
    errors,
  };
}

function parseArg(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find(item => item.startsWith(prefix));
  if (!arg) return undefined;
  return arg.slice(prefix.length);
}

function getChangedFiles(baseRef, headRef) {
  const range = baseRef ? `${baseRef}...${headRef}` : headRef;
  const result = spawnSync('git', ['diff', '--name-only', range], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    const message = result.stderr?.trim() || result.error?.message || 'git diff failed';
    throw new Error(message);
  }
  const stdout = result.stdout ?? '';
  return stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

function main() {
  if (process.env.MOZI_PROMPT_CONTRACT_BYPASS === '1') {
    console.warn('[prompt-contract] bypassed via MOZI_PROMPT_CONTRACT_BYPASS=1');
    return;
  }

  const base = parseArg('base');
  const head = parseArg('head') || 'HEAD';
  const changedFiles = getChangedFiles(base, head);
  const result = evaluatePromptContract(changedFiles);

  if (!result.ok) {
    console.error('[prompt-contract] check failed');
    console.error(`- changed files: ${result.files.length}`);
    console.error(`- runtime feature files: ${result.runtimeFeatureFiles.length}`);
    console.error(`- prompt-surface files: ${result.promptSurfaceFiles.length}`);
    for (const err of result.errors) {
      console.error(`- ${err}`);
    }
    process.exit(1);
  }

  console.log('[prompt-contract] check passed');
  console.log(`- changed files: ${result.files.length}`);
  console.log(`- runtime feature files: ${result.runtimeFeatureFiles.length}`);
  console.log(`- prompt-surface files: ${result.promptSurfaceFiles.length}`);
  console.log(`- prompt touched: ${result.promptTouched}`);
  console.log(`- changelog touched: ${result.changelogTouched}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
