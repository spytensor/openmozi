import { describe, expect, it } from 'vitest';
import {
  buildCompletionGateBlockedResponse,
  createCompletionGateState,
  evaluateCompletionGate,
  failForMissingDeliverables,
  recordCompletionGateBatch,
} from './completion-gates.js';
import type { ToolResult } from '../tools/types.js';

function call(id: string, name: string, args: Record<string, unknown> = {}) {
  return { id, function: { name, arguments: JSON.stringify(args) } };
}

function result(id: string, isError = false, content = 'ok'): ToolResult {
  return { tool_call_id: id, tool_name: id, is_error: isError, content };
}

describe('completion gate', () => {
  it('does not require verification for non-mutating turns', () => {
    const state = createCompletionGateState();
    recordCompletionGateBatch(state, [call('r1', 'read_file', { path: 'README.md' })], [result('r1')]);

    expect(evaluateCompletionGate(state)).toMatchObject({ status: 'not_required', verify_required: false });
  });

  it('requires diff and passing tests after the latest code mutation', () => {
    const state = createCompletionGateState();
    recordCompletionGateBatch(state, [call('w1', 'edit_file', { path: 'src/app.ts' })], [result('w1')]);
    expect(evaluateCompletionGate(state)).toMatchObject({ status: 'pending', missing_actions: expect.arrayContaining([
      expect.stringContaining('git_diff'),
      expect.stringContaining('run_tests'),
    ]) });

    recordCompletionGateBatch(state, [call('d1', 'git_diff'), call('t1', 'run_tests')], [result('d1'), result('t1')]);
    expect(evaluateCompletionGate(state)).toMatchObject({ status: 'passed', verify_required: true });
  });

  it('does not treat a 0-test run as a failure (a doc task has no test suite)', () => {
    const state = createCompletionGateState();
    recordCompletionGateBatch(state, [call('w1', 'write_file', { path: 'src/app.ts' })], [result('w1')]);
    // The test runner finds no tests and marks the run success:false / is_error.
    const zeroTests = '{ "total": 0, "passed": 0, "failed": 0, "skipped": 0, "failures": [], "success": false }';
    recordCompletionGateBatch(
      state,
      [call('d1', 'git_diff'), call('t1', 'run_tests')],
      [result('d1'), result('t1', true, zeroTests)],
    );
    // 0 tests = nothing to verify → the gate passes instead of blocking delivery.
    expect(evaluateCompletionGate(state)).toMatchObject({ status: 'passed' });
  });

  it('still fails when a test actually failed', () => {
    const state = createCompletionGateState();
    recordCompletionGateBatch(state, [call('w1', 'write_file', { path: 'src/app.ts' })], [result('w1')]);
    const realFail = '{ "total": 3, "passed": 2, "failed": 1, "failures": ["x"], "success": false }';
    recordCompletionGateBatch(
      state,
      [call('d1', 'git_diff'), call('t1', 'run_tests')],
      [result('d1'), result('t1', true, realFail)],
    );
    expect(evaluateCompletionGate(state)).toMatchObject({ status: 'failed' });
  });

  it('treats a successful later run of a written script as its runtime verification', () => {
    const state = createCompletionGateState();
    recordCompletionGateBatch(state, [call('w1', 'write_file', { path: '/tmp/work/generate_doc.py' })], [result('w1')]);
    expect(evaluateCompletionGate(state).status).toBe('pending');

    recordCompletionGateBatch(
      state,
      [call('s1', 'shell_exec', { command: 'python3 /tmp/work/generate_doc.py' })],
      [result('s1')],
    );
    const decision = evaluateCompletionGate(state);
    expect(decision.status).toBe('passed');
    expect(decision.missing_actions).toHaveLength(0);
  });

  it('does not treat a successful text reference as script execution', () => {
    const state = createCompletionGateState();
    recordCompletionGateBatch(state, [call('w1', 'write_file', { path: '/tmp/work/macro_report.py' })], [result('w1')]);
    recordCompletionGateBatch(
      state,
      [call('s1', 'shell_exec', { command: 'grep -n "title" /tmp/work/macro_report.py' })],
      [result('s1')],
    );

    const decision = evaluateCompletionGate(state);
    expect(decision.status).toBe('pending');
    expect(decision.missing_actions).toEqual(expect.arrayContaining([
      expect.stringContaining('git_diff'),
      expect.stringContaining('run_tests'),
    ]));
  });

  it('uses successful generator execution—not git/test tools—for artifact profiles', () => {
    const state = createCompletionGateState('artifact');
    recordCompletionGateBatch(state, [call('w1', 'write_file', { path: '/tmp/work/generate_report.py' })], [result('w1')]);
    recordCompletionGateBatch(
      state,
      [call('failed-run', 'shell_exec', { command: 'python3 /tmp/work/generate_report.py' })],
      [result('failed-run', true, 'TypeError: invalid flowable')],
    );
    recordCompletionGateBatch(state, [call('edit', 'edit_file', { path: '/tmp/work/generate_report.py' })], [result('edit')]);

    const pending = evaluateCompletionGate(state);
    expect(pending.status).toBe('pending');
    expect(pending.missing_actions).toEqual([
      expect.stringContaining('Execute the generated code'),
    ]);
    expect(pending.missing_actions.join('\n')).not.toMatch(/git_diff|run_tests/);

    recordCompletionGateBatch(
      state,
      [call('rerun', 'shell_exec', { command: 'python3 /tmp/work/generate_report.py' })],
      [result('rerun')],
    );
    expect(evaluateCompletionGate(state).status).toBe('passed');
  });

  it('does not run-verify a script executed in the same batch as its write', () => {
    const state = createCompletionGateState();
    recordCompletionGateBatch(
      state,
      [
        call('w1', 'write_file', { path: '/tmp/work/generate_doc.py' }),
        call('s1', 'shell_exec', { command: 'python3 /tmp/work/generate_doc.py' }),
      ],
      [result('w1'), result('s1')],
    );
    expect(evaluateCompletionGate(state).status).toBe('pending');
  });

  it('still demands verification for edited code that was never executed', () => {
    const state = createCompletionGateState();
    recordCompletionGateBatch(state, [call('w1', 'edit_file', { path: 'src/app.ts' })], [result('w1')]);
    recordCompletionGateBatch(
      state,
      [call('s1', 'shell_exec', { command: 'ls -la' })],
      [result('s1')],
    );
    expect(evaluateCompletionGate(state).status).toBe('pending');
  });

  it('does not count verification executed concurrently with a mutation', () => {
    const state = createCompletionGateState();
    recordCompletionGateBatch(
      state,
      [call('w1', 'write_file', { path: 'src/app.ts' }), call('d1', 'git_diff'), call('t1', 'run_tests')],
      [result('w1'), result('d1'), result('t1')],
    );

    expect(evaluateCompletionGate(state).status).toBe('pending');
  });

  it('keeps failed tests visible until a later passing run', () => {
    const state = createCompletionGateState();
    recordCompletionGateBatch(state, [call('w1', 'write_file', { path: 'src/app.ts' })], [result('w1')]);
    recordCompletionGateBatch(
      state,
      [call('d1', 'git_diff'), call('t1', 'run_tests')],
      [result('d1'), result('t1', true, '2 tests failed')],
    );
    expect(evaluateCompletionGate(state)).toMatchObject({
      status: 'failed',
      failure_reasons: [expect.stringContaining('2 tests failed')],
    });

    recordCompletionGateBatch(state, [call('t2', 'run_tests')], [result('t2', false, '12 tests passed')]);
    expect(evaluateCompletionGate(state).status).toBe('passed');
  });

  it('requires per-file readback for non-code mutations', () => {
    const state = createCompletionGateState();
    recordCompletionGateBatch(state, [call('w1', 'write_file', { path: 'docs/report.md' })], [result('w1')]);
    expect(evaluateCompletionGate(state)).toMatchObject({ status: 'pending' });

    recordCompletionGateBatch(state, [call('r1', 'read_file', { path: 'docs/report.md' })], [result('r1')]);
    expect(evaluateCompletionGate(state).status).toBe('passed');
  });

  it('requires status after git mutations and accepts successful artifact output as runtime evidence', () => {
    const state = createCompletionGateState();
    recordCompletionGateBatch(
      state,
      [call('g1', 'git_commit', { message: 'test' }), call('a1', 'create_artifact', { code: '# report' })],
      [result('g1'), result('a1')],
    );
    expect(evaluateCompletionGate(state).status).toBe('pending');

    recordCompletionGateBatch(state, [call('s1', 'git_status')], [result('s1')]);
    expect(evaluateCompletionGate(state).status).toBe('passed');
  });

  it('accepts a terminal rich file artifact as verification of its write', () => {
    const state = createCompletionGateState();
    const artifactPath = '/workspace/output/report.html';
    recordCompletionGateBatch(
      state,
      [call('w1', 'write_file', { path: artifactPath })],
      [{ ...result('w1'), file_path: artifactPath }],
      new Set([artifactPath]),
    );

    expect(evaluateCompletionGate(state)).toMatchObject({ status: 'passed', verify_required: true });
  });
});

describe('completion gate blocked response', () => {
  function pendingDecision() {
    const state = createCompletionGateState();
    recordCompletionGateBatch(state, [call('w1', 'edit_file', { path: 'src/app.ts' })], [result('w1')]);
    return evaluateCompletionGate(state);
  }

  it('delivers the candidate answer with a caveat instead of swallowing it', () => {
    const text = buildCompletionGateBlockedResponse(pendingDecision(), '梳理一下这个项目', '文档已经生成在 report.docx。');
    expect(text).toContain('文档已经生成在 report.docx。');
    expect(text).toContain('自动校验');
  });

  it('never leaks internal verifier actions or tool names to the user', () => {
    for (const userText of ['梳理一下这个项目', 'organize this project']) {
      const text = buildCompletionGateBlockedResponse(pendingDecision(), userText, 'Result body.');
      expect(text).not.toMatch(/git_diff|run_tests|git_status|read_file|Call /);
    }
  });

  it('produces a truthful standalone message when there is no candidate and no files', () => {
    const zh = buildCompletionGateBlockedResponse(pendingDecision(), '梳理一下这个项目');
    expect(zh).toContain('没有产出');
    const en = buildCompletionGateBlockedResponse(pendingDecision(), 'organize this project');
    expect(en).toContain('no deliverable final answer');
  });

  it('acknowledges produced files instead of claiming nothing when the model ends silently', () => {
    const files = ['OpenMoziDemo_项目指导手册.docx', 'OpenMoziDemo_项目指导手册.pptx', 'OpenMoziDemo_项目指导手册.pdf'];
    const zh = buildCompletionGateBlockedResponse(pendingDecision(), '梳理一下这个项目', undefined, files);
    // Never the false "produced nothing" line when real deliverables exist.
    expect(zh).not.toContain('没有产出');
    for (const name of files) expect(zh).toContain(name);
    // Still honest about incomplete verification.
    expect(zh).toContain('自动校验');

    const en = buildCompletionGateBlockedResponse(pendingDecision(), 'organize this project', undefined, files);
    expect(en).not.toContain('no deliverable final answer');
    expect(en).toContain('generated the following files');
    for (const name of files) expect(en).toContain(name);
  });

  it('still surfaces failure evidence over deliverables when verification FAILED', () => {
    const state = createCompletionGateState();
    recordCompletionGateBatch(state, [call('w1', 'edit_file', { path: 'src/app.ts' })], [result('w1')]);
    // Force a failed decision by folding in a missing claimed deliverable.
    const failed = failForMissingDeliverables(evaluateCompletionGate(state), ['/out/ghost.pdf']);
    const text = buildCompletionGateBlockedResponse(failed, 'organize this project', undefined, ['real.docx']);
    expect(text).toContain('did not pass automatic verification');
    // A genuine failure is not masked by an acknowledgement list.
    expect(text).not.toContain('generated the following files');
  });
});
