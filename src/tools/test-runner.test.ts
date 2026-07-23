import { describe, it, expect } from 'vitest';
import {
  extractVitestJsonPayload,
  parseVitestJsonOutput,
  runTests,
  type TestResult,
} from './test-runner.js';

const SAMPLE_VITEST_JSON = JSON.stringify({
  numTotalTests: 2,
  numPassedTests: 1,
  numFailedTests: 1,
  numPendingTests: 0,
  startTime: 1234567890,
  success: false,
  testResults: [{
    name: 'src/example.test.ts',
    status: 'failed',
    assertionResults: [{
      fullName: 'example fails',
      status: 'failed',
      failureMessages: ['expected true to be false'],
    }],
  }],
});

describe('tools/test-runner', () => {
  it('extracts clean vitest JSON output', () => {
    expect(extractVitestJsonPayload(SAMPLE_VITEST_JSON)).toBe(SAMPLE_VITEST_JSON);
  });

  it('extracts the final balanced vitest JSON object from noisy output', () => {
    const noisy = [
      '[dotenv] injecting env from .env',
      'Vitest 4.0.18',
      SAMPLE_VITEST_JSON,
      'Done in 1.2s',
    ].join('\n');

    expect(extractVitestJsonPayload(noisy)).toBe(SAMPLE_VITEST_JSON);
    expect(parseVitestJsonOutput(noisy)?.numFailedTests).toBe(1);
  });

  it('parses zero-test vitest reporter output', () => {
    const zero = JSON.stringify({
      numTotalTests: 0,
      numPassedTests: 0,
      numFailedTests: 0,
      numPendingTests: 0,
      startTime: 1234567890,
      success: true,
      testResults: [],
    });

    const parsed = parseVitestJsonOutput(zero);
    expect(parsed?.numTotalTests).toBe(0);
    expect(parsed?.success).toBe(true);
  });

  it('runTests with a specific file returns valid TestResult', async () => {
    const result = await runTests({ file: 'src/store/events.test.ts', timeout_ms: 60_000 });

    expect(result).toHaveProperty('total');
    expect(result).toHaveProperty('passed');
    expect(result).toHaveProperty('failed');
    expect(result).toHaveProperty('skipped');
    expect(result).toHaveProperty('duration_ms');
    expect(result).toHaveProperty('failures');
    expect(result).toHaveProperty('success');

    expect(typeof result.total).toBe('number');
    expect(typeof result.passed).toBe('number');
    expect(typeof result.failed).toBe('number');
    expect(typeof result.skipped).toBe('number');
    expect(typeof result.duration_ms).toBe('number');
    expect(Array.isArray(result.failures)).toBe(true);
    expect(typeof result.success).toBe('boolean');

    expect(result.total).toBeGreaterThan(0);
    expect(result.success).toBe(true);
    expect(result.passed).toBe(result.total);
    expect(result.failures).toHaveLength(0);
  }, 60_000);

  it('runTests with nonexistent file handles gracefully', async () => {
    const result = await runTests({ file: 'nonexistent.test.ts', timeout_ms: 30_000 });

    // vitest with a nonexistent file either returns 0 tests or errors
    expect(result).toHaveProperty('total');
    expect(result).toHaveProperty('success');
    expect(typeof result.total).toBe('number');
    expect(typeof result.success).toBe('boolean');
  }, 30_000);

  it('parses failed test reporter output shape', () => {
    const parsed = parseVitestJsonOutput(SAMPLE_VITEST_JSON);

    expect(parsed?.success).toBe(false);
    expect(parsed?.testResults[0]?.assertionResults[0]?.fullName).toBe('example fails');
  });

  it('TestResult structure has all required fields', () => {
    const result: TestResult = {
      total: 10,
      passed: 8,
      failed: 1,
      skipped: 1,
      duration_ms: 5000,
      failures: [{
        name: 'test case',
        file: 'test.ts',
        error_message: 'expected true',
        stack_lines: ['at line 1'],
      }],
      success: false,
    };

    expect(result.total).toBe(10);
    expect(result.passed).toBe(8);
    expect(result.failed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.duration_ms).toBe(5000);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].name).toBe('test case');
    expect(result.failures[0].file).toBe('test.ts');
    expect(result.failures[0].error_message).toBe('expected true');
    expect(result.failures[0].stack_lines).toEqual(['at line 1']);
    expect(result.success).toBe(false);
  });
});
