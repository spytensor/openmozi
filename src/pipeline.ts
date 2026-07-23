/**
 * Development pipeline — automates issue → verify → commit → push → close workflow.
 */
import { execFileSync } from 'node:child_process';

function formatCommand(command: string, args: string[]): string {
  return [command, ...args.map((arg) => JSON.stringify(arg))].join(' ');
}

function sh(command: string, args: string[] = [], inherit = false): string {
  try {
    if (inherit) {
      execFileSync(command, args, { stdio: 'inherit' });
      return '';
    }
    return execFileSync(command, args, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Command failed: ${formatCommand(command, args)}\n${msg}`);
  }
}

/** Create a GitHub issue. Returns issue number. */
export function cmdPipelineIssue(title: string, body: string): number {
  console.log('📋 Creating GitHub issue...');
  const url = sh('gh', ['issue', 'create', '--title', title, '--body', body]);
  const match = url.match(/\/(\d+)$/);
  if (!match) { console.error('Failed to parse issue URL:', url); process.exit(1); }
  const num = parseInt(match[1], 10);
  console.log(`✅ Issue #${num} created: ${url}`);
  return num;
}

/** Run build + test. Returns true if both pass. */
export function cmdPipelineVerify(): boolean {
  console.log('🔨 Building...');
  try {
    sh('pnpm', ['build'], true);
  } catch {
    console.error('❌ Build failed');
    return false;
  }
  console.log('🧪 Testing...');
  try {
    sh('pnpm', ['test'], true);
  } catch {
    console.error('❌ Tests failed');
    return false;
  }
  console.log('✅ Build + tests passed');
  return true;
}

/** Commit staged + unstaged changes referencing an issue. Returns commit hash. */
export function cmdPipelineCommit(issueNum: number, message: string): string {
  sh('git', ['add', '-A']);
  const commitMsg = `${message} (#${issueNum})\n\nCo-authored-by: Mozi <MoziAI-co@users.noreply.github.com>`;
  sh('git', ['commit', '-m', commitMsg]);
  const hash = sh('git', ['rev-parse', '--short', 'HEAD']);
  console.log(`✅ Committed: ${hash}`);
  return hash;
}

/** Push current branch to origin. */
export function cmdPipelinePush(): void {
  console.log('🚀 Pushing...');
  const branch = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  sh('git', ['push', 'origin', branch]);
  console.log(`✅ Pushed to origin/${branch}`);
}

/** Close a GitHub issue with optional comment. */
export function cmdPipelineClose(issueNum: number, comment?: string): void {
  const args = ['issue', 'close', String(issueNum)];
  if (comment) args.push('--comment', comment);
  sh('gh', args);
  console.log(`✅ Issue #${issueNum} closed`);
}

/** Full pipeline: issue → verify → commit → push → close. */
export function cmdPipelineRun(title: string, body: string): void {
  console.log('═══════════════════════════════════════');
  console.log(' MOZI Development Pipeline');
  console.log('═══════════════════════════════════════\n');

  // Step 1: Create issue
  console.log('[1/5] Creating issue...');
  const issueNum = cmdPipelineIssue(title, body);

  // Step 2: Verify
  console.log('\n[2/5] Verifying build + tests...');
  const ok = cmdPipelineVerify();
  if (!ok) {
    console.error(`\n❌ Pipeline stopped — fix issues and run: mozi pipeline close ${issueNum}`);
    process.exit(1);
  }

  // Step 3: Commit
  console.log('\n[3/5] Committing...');
  const hash = cmdPipelineCommit(issueNum, title);

  // Step 4: Push
  console.log('\n[4/5] Pushing...');
  cmdPipelinePush();

  // Step 5: Close issue
  console.log('\n[5/5] Closing issue...');
  cmdPipelineClose(issueNum, `Implemented in ${hash}.`);

  console.log('\n═══════════════════════════════════════');
  console.log(` ✅ Pipeline complete — Issue #${issueNum} → ${hash}`);
  console.log('═══════════════════════════════════════');
}
