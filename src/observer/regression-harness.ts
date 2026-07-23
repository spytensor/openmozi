import {
  runFailureReplay,
  type FailureReplayFixture,
  type FailureReplayResult,
  type RunFailureReplayOptions,
} from './failure-replay.js';
import {
  getPromptSnapshot,
  type PromptSnapshot,
} from './prompt-snapshot.js';

export type RegressionCategory =
  | 'path_guessing'
  | 'lesson_pollution'
  | 'tool_truth_override'
  | 'truncation_drift'
  | 'timeout'
  | 'verification_failure'
  | 'general';

export interface RegressionFixture {
  id: string;
  category: RegressionCategory;
  description: string;
  fixture: FailureReplayFixture;
  snapshot?: PromptSnapshot;
  assertions?: RegressionAssertion[];
}

export interface RegressionAssertion {
  field: string;
  op: 'eq' | 'neq' | 'contains' | 'not_contains' | 'gt' | 'lt';
  value: unknown;
  message?: string;
}

export interface RegressionCaseResult {
  id: string;
  category: RegressionCategory;
  description: string;
  passed: boolean;
  replay: FailureReplayResult;
  assertion_failures: string[];
  snapshot_present: boolean;
}

export interface RegressionRunSummary {
  total: number;
  passed: number;
  failed: number;
  by_category: Record<string, { total: number; passed: number; failed: number }>;
  cases: RegressionCaseResult[];
  ran_at: string;
}

// Dot-path traversal — numeric segments index into arrays (e.g. "slots.1.name").
function resolveField(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function checkAssertion(result: FailureReplayResult, snapshot: PromptSnapshot | undefined, assertion: RegressionAssertion): string | null {
  const target = assertion.field.startsWith('snapshot.')
    ? resolveField(snapshot, assertion.field.slice('snapshot.'.length))
    : resolveField(result, assertion.field);

  switch (assertion.op) {
    case 'eq':
      if (target !== assertion.value) {
        return assertion.message ?? `${assertion.field}: expected ${JSON.stringify(assertion.value)}, got ${JSON.stringify(target)}`;
      }
      break;
    case 'neq':
      if (target === assertion.value) {
        return assertion.message ?? `${assertion.field}: should not equal ${JSON.stringify(assertion.value)}`;
      }
      break;
    case 'contains':
      if (typeof target !== 'string' || typeof assertion.value !== 'string' || !target.includes(assertion.value)) {
        return assertion.message ?? `${assertion.field}: should contain ${JSON.stringify(assertion.value)}`;
      }
      break;
    case 'not_contains':
      if (typeof target === 'string' && typeof assertion.value === 'string' && target.includes(assertion.value)) {
        return assertion.message ?? `${assertion.field}: should not contain ${JSON.stringify(assertion.value)}`;
      }
      break;
    case 'gt':
      if (typeof target !== 'number' || typeof assertion.value !== 'number' || target <= assertion.value) {
        return assertion.message ?? `${assertion.field}: expected > ${assertion.value}, got ${target}`;
      }
      break;
    case 'lt':
      if (typeof target !== 'number' || typeof assertion.value !== 'number' || target >= assertion.value) {
        return assertion.message ?? `${assertion.field}: expected < ${assertion.value}, got ${target}`;
      }
      break;
  }
  return null;
}

export async function runRegressionCase(
  regressionFixture: RegressionFixture,
  options: RunFailureReplayOptions = {},
): Promise<RegressionCaseResult> {
  const replay = await runFailureReplay(regressionFixture.fixture, options);

  let snapshot: PromptSnapshot | undefined = regressionFixture.snapshot ?? undefined;
  if (!snapshot) {
    try {
      snapshot = getPromptSnapshot(regressionFixture.fixture.trace.trace_id, regressionFixture.fixture.trace.tenant_id) ?? undefined;
    } catch {
      // DB may not be initialized in pure-fixture regression runs
    }
  }

  const assertionFailures: string[] = [];
  if (regressionFixture.assertions) {
    for (const assertion of regressionFixture.assertions) {
      const failure = checkAssertion(replay, snapshot, assertion);
      if (failure) assertionFailures.push(failure);
    }
  }

  return {
    id: regressionFixture.id,
    category: regressionFixture.category,
    description: regressionFixture.description,
    passed: replay.passed && assertionFailures.length === 0,
    replay,
    assertion_failures: assertionFailures,
    snapshot_present: snapshot !== undefined,
  };
}

export async function runRegressionSuite(
  fixtures: RegressionFixture[],
  options: RunFailureReplayOptions = {},
): Promise<RegressionRunSummary> {
  const cases: RegressionCaseResult[] = [];
  const byCategory: Record<string, { total: number; passed: number; failed: number }> = {};

  for (const fixture of fixtures) {
    const result = await runRegressionCase(fixture, options);
    cases.push(result);

    if (!byCategory[result.category]) {
      byCategory[result.category] = { total: 0, passed: 0, failed: 0 };
    }
    byCategory[result.category].total += 1;
    if (result.passed) {
      byCategory[result.category].passed += 1;
    } else {
      byCategory[result.category].failed += 1;
    }
  }

  return {
    total: cases.length,
    passed: cases.filter(c => c.passed).length,
    failed: cases.filter(c => !c.passed).length,
    by_category: byCategory,
    cases,
    ran_at: new Date().toISOString(),
  };
}

export function formatRegressionSummary(summary: RegressionRunSummary): string {
  const lines: string[] = [
    `Regression Suite: ${summary.passed}/${summary.total} passed`,
    '',
  ];

  for (const [category, stats] of Object.entries(summary.by_category)) {
    lines.push(`  ${category}: ${stats.passed}/${stats.total} passed`);
  }

  const failedCases = summary.cases.filter(c => !c.passed);
  if (failedCases.length > 0) {
    lines.push('');
    lines.push('Failures:');
    for (const c of failedCases) {
      lines.push(`  [${c.category}] ${c.id}: ${c.description}`);
      for (const m of c.replay.mismatches) {
        lines.push(`    - ${m}`);
      }
      for (const a of c.assertion_failures) {
        lines.push(`    - ${a}`);
      }
    }
  }

  return lines.join('\n');
}
