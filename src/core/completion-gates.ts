import { basename, extname, normalize } from 'node:path';
import type { ToolResult } from '../tools/types.js';

export type CompletionGateStatus = 'not_required' | 'pending' | 'passed' | 'failed';

export interface CompletionGateDecision {
  status: CompletionGateStatus;
  verify_required: boolean;
  summary: string;
  missing_actions: string[];
  failure_reasons: string[];
}

interface MutationRecord {
  path: string;
  batch: number;
  kind: 'code' | 'non_code';
  /**
   * Batch in which this file was successfully EXECUTED after being written
   * (e.g. `python generate_doc.py`). A script written and then run without
   * error in a later batch is runtime-verified by that run — demanding
   * git_diff + run_tests for a one-off generation script misclassifies
   * document work as a project code change.
   */
  verifiedByRunBatch?: number;
  /** A real interpreter/runtime invocation targeted this file, but it may have
   * failed. Artifact-oriented tasks use this to request a corrected rerun
   * instead of unrelated git/test evidence. */
  attemptedByRunBatch?: number;
}

interface EvidenceRecord {
  batch: number;
  passed: boolean;
  summary: string;
}

export interface CompletionGateState {
  mode: 'project' | 'artifact';
  batch: number;
  mutations: Map<string, MutationRecord>;
  gitMutationBatch: number;
  artifactMutationBatch: number;
  gitDiff?: EvidenceRecord;
  gitStatus?: EvidenceRecord;
  tests?: EvidenceRecord;
  readbacks: Map<string, EvidenceRecord>;
}

interface GateToolCall {
  id: string;
  function: { name: string; arguments: string };
}

const FILE_MUTATION_TOOLS = new Set(['write_file', 'edit_file', 'append_file']);
const GIT_MUTATION_TOOLS = new Set(['git_add', 'git_commit', 'git_revert']);
const ARTIFACT_MUTATION_TOOLS = new Set(['create_artifact', 'update_artifact']);
const CODE_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cs', '.css', '.go', '.h', '.hpp', '.html', '.java', '.js', '.jsx',
  '.kt', '.mjs', '.cjs', '.php', '.py', '.rb', '.rs', '.scss', '.sh', '.sql', '.svelte',
  '.swift', '.ts', '.tsx', '.vue', '.wasm',
]);
const CODE_FILENAMES = new Set([
  'dockerfile', 'makefile', 'package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'vite.config.ts',
]);

export function createCompletionGateState(mode: 'project' | 'artifact' = 'project'): CompletionGateState {
  return {
    mode,
    batch: 0,
    mutations: new Map(),
    gitMutationBatch: 0,
    artifactMutationBatch: 0,
    readbacks: new Map(),
  };
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function normalizedPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  return normalize(value.trim());
}

function isCodePath(path: string): boolean {
  return CODE_EXTENSIONS.has(extname(path).toLowerCase())
    || CODE_FILENAMES.has(basename(path).toLowerCase());
}

const SCRIPT_INTERPRETERS = new Set([
  'python', 'python3', 'node', 'bun', 'deno', 'bash', 'sh', 'zsh', 'ruby', 'php',
]);

/** True only when a shell segment invokes the written file as a program. Mere
 * text references (`grep macro_report.py`, `ls macro_report.py`) are not runtime
 * verification. */
function commandExecutesCodePath(command: string, path: string): boolean {
  const target = basename(path);
  for (const rawSegment of command.split(/&&|\|\||;|\n/)) {
    let segment = rawSegment.trim();
    if (!segment) continue;
    if (segment.startsWith('env ')) segment = segment.slice(4).trimStart();
    while (/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+/.test(segment)) {
      segment = segment.replace(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+/, '').trimStart();
    }
    const executable = segment.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/)?.slice(1).find(Boolean);
    if (!executable) continue;
    const executableName = basename(executable).toLowerCase();
    const interpreter = SCRIPT_INTERPRETERS.has(executableName)
      || /^python\d*(?:\.\d+)*$/.test(executableName);
    if (interpreter && segment.includes(target)) return true;
    if ((executable === path || basename(executable) === target) && !interpreter) return true;
  }
  return false;
}

function summarizeResult(result: ToolResult): string {
  const content = typeof result.content === 'string' ? result.content.trim() : String(result.content ?? '');
  return content.slice(0, 280) || (result.is_error ? 'Tool reported an error.' : 'Tool completed.');
}

/** Record one concurrently executed tool batch. Evidence in the same batch as a mutation is not post-mutation evidence. */
/**
 * A test run that found NO tests (total === 0) is "nothing to verify", not a
 * failure — a document/generation task legitimately has no test suite, and the
 * test runner marks that run success:false. Blocking a produced deliverable on
 * it (and leaking the raw JSON as evidence) is wrong. Otherwise pass when no
 * test actually failed; fall back to the tool error flag for non-JSON output.
 */
function runTestsPassed(result: ToolResult): boolean {
  try {
    const data = JSON.parse(String(result.content ?? '')) as { total?: number; failed?: number };
    if (typeof data.total === 'number' && data.total === 0) return true;
    if (typeof data.failed === 'number') return data.failed === 0;
  } catch {
    // Non-JSON test output — fall back to the tool's error flag.
  }
  return !result.is_error;
}

export function recordCompletionGateBatch(
  state: CompletionGateState,
  toolCalls: GateToolCall[],
  results: ToolResult[],
  verifiedArtifactPaths: Set<string> = new Set(),
): void {
  state.batch += 1;
  const batch = state.batch;
  const resultById = new Map(results.map(result => [result.tool_call_id, result]));

  for (const call of toolCalls) {
    const result = resultById.get(call.id);
    if (!result) continue;
    const name = call.function.name;
    const args = parseArguments(call.function.arguments);

    if (!result.is_error && FILE_MUTATION_TOOLS.has(name)) {
      const path = normalizedPath(result.file_path ?? args.path);
      if (path && (result.artifact_verified === true || verifiedArtifactPaths.has(path))) {
        state.mutations.delete(path);
        state.artifactMutationBatch = batch;
      } else if (path) {
        const previous = state.mutations.get(path);
        state.mutations.set(path, {
          path,
          batch,
          kind: isCodePath(path) ? 'code' : 'non_code',
          ...(previous?.attemptedByRunBatch ? { attemptedByRunBatch: previous.attemptedByRunBatch } : {}),
        });
      }
    }
    if (!result.is_error && name === 'improve_code' && args.auto_apply === true) {
      const target = normalizedPath(args.target);
      if (target) state.mutations.set(target, { path: target, batch, kind: 'code' });
    }
    if (name === 'shell_exec' || name === 'shell_exec_bg') {
      if (!result.is_error) {
        const paths = Array.isArray(args.checkpoint_paths) ? args.checkpoint_paths : [];
        for (const rawPath of paths) {
          const path = normalizedPath(rawPath);
          if (path) state.mutations.set(path, { path, batch, kind: isCodePath(path) ? 'code' : 'non_code' });
        }
      }
      // A real interpreter invocation of an earlier-written code file is an
      // execution attempt. It becomes verification only if the command passes.
      // Same-batch runs do not count as post-mutation evidence.
      const command = typeof args.command === 'string' ? args.command : '';
      if (command) {
        for (const mutation of state.mutations.values()) {
          if (mutation.kind !== 'code' || mutation.batch >= batch) continue;
          if (commandExecutesCodePath(command, mutation.path)) {
            mutation.attemptedByRunBatch = batch;
            if (!result.is_error) mutation.verifiedByRunBatch = batch;
          }
        }
      }
    }
    if (!result.is_error && GIT_MUTATION_TOOLS.has(name)) state.gitMutationBatch = batch;
    if (!result.is_error && ARTIFACT_MUTATION_TOOLS.has(name)) state.artifactMutationBatch = batch;

    if (name === 'git_diff') {
      state.gitDiff = { batch, passed: !result.is_error, summary: summarizeResult(result) };
    } else if (name === 'git_status') {
      state.gitStatus = { batch, passed: !result.is_error, summary: summarizeResult(result) };
    } else if (name === 'run_tests') {
      state.tests = { batch, passed: runTestsPassed(result), summary: summarizeResult(result) };
    } else if (name === 'read_file') {
      const path = normalizedPath(args.path);
      if (path) state.readbacks.set(path, { batch, passed: !result.is_error, summary: summarizeResult(result) });
    }
  }
}

export function evaluateCompletionGate(state: CompletionGateState): CompletionGateDecision {
  const mutations = [...state.mutations.values()];
  const verifyRequired = mutations.length > 0 || state.gitMutationBatch > 0 || state.artifactMutationBatch > 0;
  if (!verifyRequired) {
    return {
      status: 'not_required',
      verify_required: false,
      summary: 'No tracked mutations occurred in this turn.',
      missing_actions: [],
      failure_reasons: [],
    };
  }

  const missing: string[] = [];
  const failures: string[] = [];
  const unverifiedCode = mutations.filter(
    mutation => mutation.kind === 'code' && !(mutation.verifiedByRunBatch && mutation.verifiedByRunBatch > mutation.batch),
  );
  // Artifact/report profiles write disposable generator scripts. Their proof is
  // a successful post-mutation execution, not repository git/test evidence that
  // those tool profiles intentionally do not expose.
  if (state.mode === 'artifact') {
    for (const mutation of unverifiedCode) {
      missing.push(`Execute the generated code after its latest mutation and confirm it exits successfully: ${mutation.path}`);
    }
  }
  // Project code still requires review + tests. Run-verified scripts and all
  // artifact-mode generators are excluded from that project-code contract.
  const codeMutations = state.mode === 'project' ? unverifiedCode : [];
  const latestCodeMutation = Math.max(0, ...codeMutations.map(mutation => mutation.batch));
  if (latestCodeMutation > 0) {
    if (!state.gitDiff || state.gitDiff.batch <= latestCodeMutation) {
      missing.push('Call git_diff after the latest code mutation and review the result.');
    } else if (!state.gitDiff.passed) {
      failures.push(`git_diff failed: ${state.gitDiff.summary}`);
    }

    if (!state.tests || state.tests.batch <= latestCodeMutation) {
      missing.push('Call run_tests after the latest code mutation.');
    } else if (!state.tests.passed) {
      failures.push(`Tests failed: ${state.tests.summary}`);
    }
  }

  for (const mutation of mutations.filter(item => item.kind === 'non_code')) {
    const readback = state.readbacks.get(mutation.path);
    if (!readback || readback.batch <= mutation.batch) {
      missing.push(`Call read_file for "${mutation.path}" after its latest mutation.`);
    } else if (!readback.passed) {
      failures.push(`Readback failed for "${mutation.path}": ${readback.summary}`);
    }
  }

  if (state.gitMutationBatch > 0) {
    if (!state.gitStatus || state.gitStatus.batch <= state.gitMutationBatch) {
      missing.push('Call git_status after the latest git mutation.');
    } else if (!state.gitStatus.passed) {
      failures.push(`git_status failed: ${state.gitStatus.summary}`);
    }
  }

  const status: CompletionGateStatus = failures.length > 0 ? 'failed' : missing.length > 0 ? 'pending' : 'passed';
  const summary = status === 'passed'
    ? `Verification passed for ${mutations.length} file mutation(s)${state.artifactMutationBatch > 0 ? ' and artifact output' : ''}.`
    : status === 'failed'
      ? `Verification failed with ${failures.length} failure(s).`
      : `Verification is pending ${missing.length} required action(s).`;
  return {
    status,
    verify_required: true,
    summary,
    missing_actions: [...new Set(missing)],
    failure_reasons: [...new Set(failures)],
  };
}

/**
 * Fold fabricated-deliverable evidence into a gate decision. When the final
 * message claims one or more files that do not exist on disk, the turn is
 * downgraded to `failed` — the strongest category, whose blocked-response path
 * delivers the honest failure instead of the fabricated success. This is the
 * runtime asserting a FACT (the file is not there), which overrides any
 * narration the Brain produced.
 */
export function failForMissingDeliverables(
  decision: CompletionGateDecision,
  missingPaths: readonly string[],
): CompletionGateDecision {
  if (missingPaths.length === 0) return decision;
  const reasons = missingPaths.map(
    (path) => `Claimed deliverable not found on disk: ${path} — actually produce the file (then confirm with read_file/list_directory) or drop the delivery claim.`,
  );
  return {
    status: 'failed',
    verify_required: true,
    summary: `Verification failed: ${missingPaths.length} claimed deliverable file(s) do not exist on disk.`,
    missing_actions: decision.missing_actions ?? [],
    failure_reasons: [...new Set([...(decision.failure_reasons ?? []), ...reasons])],
  };
}

export function buildCompletionGateFeedback(decision: CompletionGateDecision): string {
  return [
    '[RUNTIME VERIFIER — candidate response rejected]',
    `Status: ${decision.status}`,
    decision.summary,
    ...decision.missing_actions.map(action => `Required: ${action}`),
    ...decision.failure_reasons.map(reason => `Failure: ${reason}`),
    'Continue the same task using the required verification tools. Do not claim completion until the runtime gate passes.',
  ].join('\n');
}

/**
 * Final message when the gate still blocks after all feedback retries.
 *
 * - `pending` (verification simply incomplete): the model's actual output is
 *   delivered with an honest caveat - swallowing a real deliverable because a
 *   checklist item is missing punishes the user, not the model.
 * - `failed` (runtime evidence CONTRADICTS the model's claim, e.g. tests
 *   failed): the claim must NOT be delivered as-is; the user gets the truthful
 *   failure evidence instead.
 *
 * Internal verifier ACTIONS ("Call git_diff...") never reach the user surface -
 * they belong in logs and the decision metadata. Failure EVIDENCE (what broke)
 * does reach the user: that is truth they need to act on.
 */
export function buildCompletionGateBlockedResponse(
  decision: CompletionGateDecision,
  userText: string,
  candidateText?: string,
  deliverables: readonly string[] = [],
): string {
  const zh = /[\u3400-\u9fff]/.test(userText);

  if (decision.status === 'failed') {
    const evidence = decision.failure_reasons.join(' ');
    return zh
      ? `这轮的改动没有通过自动校验，我不能按原样交付结果。${evidence} 可以让我继续修复，或先检查当前状态。`.trim()
      : `The changes did not pass automatic verification, so I cannot deliver the result as claimed. ${evidence} Ask me to keep fixing, or review the current state first.`.trim();
  }

  const caveat = zh
    ? '注意：这轮工作的自动校验没有全部完成，我不能确认每一步都已验证，请检查结果是否符合预期。'
    : 'Note: automatic verification for this turn did not fully complete, so I could not confirm every step - please check that the result matches what you expect.';

  const candidate = candidateText?.trim();
  if (candidate) return `${candidate}\n\n${caveat}`;

  // The model produced no closing text, but real file deliverables ARE a
  // deliverable — "did we deliver?" and "did verification finish?" are
  // orthogonal questions. Acknowledge the produced files (a runtime fact)
  // instead of falsely claiming nothing was produced. Only a truly empty
  // turn — no text AND no files — gets the retry message.
  if (deliverables.length > 0) {
    const list = deliverables.map(name => `- ${name}`).join('\n');
    return zh
      ? `已为你生成以下文件：\n${list}\n\n${caveat}`
      : `I've generated the following files for you:\n${list}\n\n${caveat}`;
  }

  return zh
    ? '这轮工作没有产出可交付的最终回答，自动校验也未完成。请让我重试，或告诉我需要优先处理哪一步。'
    : 'This turn produced no deliverable final answer and its automatic verification did not complete. Ask me to retry, or tell me which step to prioritize.';
}
