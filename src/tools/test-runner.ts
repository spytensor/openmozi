import { execFile } from 'node:child_process';
import { rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { getRuntimeProjectRoot } from '../runtime/project-root.js';
import pino from 'pino';

const logger = pino({ name: 'mozi:test-runner' });
const execFileAsync = promisify(execFile);
const MAX_TEST_OUTPUT_BYTES = 10 * 1024 * 1024;

export interface FailedTest {
  name: string;
  file: string;
  error_message: string;
  stack_lines: string[];
}

export interface TestResult {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  duration_ms: number;
  failures: FailedTest[];
  success: boolean;
}

export interface RunTestsOptions {
  file?: string;
  grep?: string;
  timeout_ms?: number;
}

/** Vitest JSON reporter assertion result shape */
interface VitestAssertionResult {
  fullName: string;
  status: string;
  failureMessages: string[];
}

/** Vitest JSON reporter test result shape */
interface VitestTestResult {
  name: string;
  status: string;
  assertionResults: VitestAssertionResult[];
}

/** Vitest JSON reporter top-level output shape */
interface VitestJsonOutput {
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  startTime: number;
  success: boolean;
  testResults: VitestTestResult[];
}

interface ExecFileLikeError extends Error {
  code?: number | string | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
}

function normalizeExecBuffer(value: string | Buffer | undefined): string {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf-8');
  return '';
}

function isVitestJsonOutput(value: unknown): value is VitestJsonOutput {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.numTotalTests === 'number'
    && typeof record.numPassedTests === 'number'
    && typeof record.numFailedTests === 'number'
    && typeof record.numPendingTests === 'number'
    && typeof record.success === 'boolean'
    && Array.isArray(record.testResults);
}

export function extractVitestJsonPayload(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;

  const candidates: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\' && inString) {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === '{') {
      if (depth === 0) {
        start = i;
      }
      depth += 1;
      continue;
    }

    if (char === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }

  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(candidates[i]) as unknown;
      if (isVitestJsonOutput(parsed)) {
        return candidates[i];
      }
    } catch {
      // Keep scanning; noisy stdout can contain unrelated brace pairs.
    }
  }

  return null;
}

export function parseVitestJsonOutput(raw: string): VitestJsonOutput | null {
  const payload = extractVitestJsonPayload(raw);
  if (!payload) return null;

  try {
    const parsed = JSON.parse(payload) as unknown;
    return isVitestJsonOutput(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function runVitest(
  args: string[],
  timeout: number,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  try {
    const result = await execFileAsync('npx', args, {
      cwd: getRuntimeProjectRoot(),
      timeout,
      maxBuffer: MAX_TEST_OUTPUT_BYTES,
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: 0,
    };
  } catch (err) {
    const error = err as ExecFileLikeError;
    if (error && (error.stdout !== undefined || error.stderr !== undefined || error.code !== undefined)) {
      return {
        stdout: normalizeExecBuffer(error.stdout),
        stderr: normalizeExecBuffer(error.stderr),
        exitCode: typeof error.code === 'number' ? error.code : null,
      };
    }
    throw err;
  }
}

async function readOutputFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return '';
  }
}

function buildTestResult(json: VitestJsonOutput, durationMs: number): TestResult {
  const failures: FailedTest[] = [];
  for (const testFile of json.testResults) {
    for (const assertion of testFile.assertionResults) {
      if (assertion.status === 'failed') {
        const errorMsg = assertion.failureMessages.join('\n');
        failures.push({
          name: assertion.fullName,
          file: testFile.name,
          error_message: errorMsg,
          stack_lines: errorMsg.split('\n').slice(0, 10),
        });
      }
    }
  }

  return {
    total: json.numTotalTests,
    passed: json.numPassedTests,
    failed: json.numFailedTests,
    skipped: json.numPendingTests,
    duration_ms: durationMs,
    failures,
    success: json.success,
  };
}

/**
 * Run project tests via vitest with JSON reporter and return structured results.
 */
export async function runTests(options?: RunTestsOptions): Promise<TestResult> {
  const outputFile = join(
    tmpdir(),
    `mozi-vitest-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
  );
  const args = [
    'vitest',
    'run',
    '--exclude',
    '**/.claude/worktrees/**',
    '--reporter=json',
    '--outputFile',
    outputFile,
  ];

  if (options?.grep) {
    args.push('--testNamePattern', options.grep);
  }

  if (options?.file) {
    args.push(options.file);
  }

  const timeout = options?.timeout_ms ?? 120_000;

  logger.info({ command: ['npx', ...args].join(' '), timeout }, 'Running tests');

  const startTime = Date.now();
  try {
    const result = await runVitest(args, timeout);
    const elapsed = Date.now() - startTime;
    const outputCandidates = [
      await readOutputFile(outputFile),
      result.stdout,
      result.stderr,
      `${result.stdout}\n${result.stderr}`,
    ];

    for (const candidate of outputCandidates) {
      const parsed = parseVitestJsonOutput(candidate);
      if (parsed) {
        return buildTestResult(parsed, elapsed);
      }
    }

    logger.warn(
      {
        exit_code: result.exitCode,
        stdout: result.stdout.slice(0, 500),
        stderr: result.stderr.slice(0, 500),
      },
      'Failed to parse vitest JSON output',
    );

    return {
      total: 0,
      passed: 0,
      failed: 1,
      skipped: 0,
      duration_ms: elapsed,
      failures: [{
        name: 'parse_error',
        file: '',
        error_message: result.stderr || result.stdout || 'Unknown error',
        stack_lines: [],
      }],
      success: false,
    };
  } catch {
    const elapsed = Date.now() - startTime;
    return {
      total: 0,
      passed: 0,
      failed: 1,
      skipped: 0,
      duration_ms: elapsed,
      failures: [{
        name: 'runner_error',
        file: '',
        error_message: 'Failed to execute vitest',
        stack_lines: [],
      }],
      success: false,
    };
  } finally {
    await rm(outputFile, { force: true }).catch(() => undefined);
  }
}
