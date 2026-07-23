import { describe, it, expect, afterEach, afterAll, beforeEach } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  exec,
  isDeliverableShelfDeletion,
  isHostSchedulerMutation,
  resetSanitizedEnvCache,
  execBackground,
  getProcessStatus,
  getProcessOutput,
  sendProcessInput,
  killProcess,
  killAllProcesses,
} from './shell.js';
import { getOutputDir } from '../tools/workspace-policy.js';

describe('capabilities/shell — deliverable-shelf integrity (2026-07-19)', () => {
  it('blocks deletion verbs that reference the output directory, in every mode', async () => {
    const outputDir = getOutputDir();
    // The real incident's shape: rm -f with the quoted absolute output path.
    const incident = `rm -f "${outputDir}/Online_Retail_业务健康度分析报告.pdf"`;
    expect(isDeliverableShelfDeletion(incident)).toBe(true);
    const result = await exec(incident);
    expect(result.blocked).toBe(true);
    expect(result.stderr).toContain('deliverables directory');

    // Escaped-space (unquoted) form is caught too.
    const escaped = `rm ${outputDir.replace(/ /g, '\\ ')}/report.pdf`;
    expect(isDeliverableShelfDeletion(escaped)).toBe(true);
    // Chained deletion is caught.
    expect(isDeliverableShelfDeletion(`ls && rm -rf "${outputDir}"`)).toBe(true);
  });

  it('does not block reads, copies, or deletions elsewhere', () => {
    const outputDir = getOutputDir();
    expect(isDeliverableShelfDeletion(`ls -lh "${outputDir}"`)).toBe(false);
    expect(isDeliverableShelfDeletion(`cp "${outputDir}/a.pdf" /tmp/a.pdf`)).toBe(false);
    expect(isDeliverableShelfDeletion('rm -f /tmp/scratch.txt')).toBe(false);
    // A deletion verb in one segment and the path only as a READ target in
    // the same command is a known over-block; deletion verbs beside the
    // output path stay rare enough that safety wins.
  });
});

describe('capabilities/shell — managed scheduler boundary', () => {
  it('blocks host scheduler mutations in foreground and background modes', async () => {
    for (const command of [
      'printf "15 15 * * * job" | crontab -',
      'crontab -r',
      'launchctl bootstrap gui/501 ~/Library/LaunchAgents/example.plist',
      'echo job | at 15:15',
      'systemctl enable report.timer',
    ]) {
      expect(isHostSchedulerMutation(command)).toBe(true);
      const foreground = await exec(command);
      expect(foreground.blocked).toBe(true);
      expect(foreground.stderr).toContain('managed scheduler tools');
      const background = await exec(command, { background: true });
      expect(background.blocked).toBe(true);
    }
  });

  it('allows read-only scheduler inspection', async () => {
    expect(isHostSchedulerMutation('crontab -l')).toBe(false);
    expect(isHostSchedulerMutation('launchctl list')).toBe(false);
    expect(isHostSchedulerMutation('rg crontab docs/')).toBe(false);
    expect(isHostSchedulerMutation('echo "meet at 15:15"')).toBe(false);
  });
});

describe('capabilities/shell', () => {
  it('echo hello → stdout "hello\\n", exit_code 0', async () => {
    const result = await exec('echo hello');
    expect(result.stdout.trim()).toBe('hello');
    expect(result.exit_code).toBe(0);
    expect(result.timed_out).toBe(false);
    expect(result.blocked).toBe(false);
    expect(['native', 'docker']).toContain(result.executor);
  });

  it('captures stderr', async () => {
    const result = await exec('echo error >&2');
    expect(result.stderr.trim()).toBe('error');
    expect(result.exit_code).toBe(0);
  });

  it('returns non-zero exit code', async () => {
    const result = await exec('exit 42');
    expect(result.exit_code).toBe(42);
  });

  it('timeout kills long-running command', async () => {
    const result = await exec('sleep 10', { timeout: 500 });
    expect(result.timed_out).toBe(true);
    expect(result.exit_code).toBe(-1);
  });

  it('restricted mode blocks rm -rf /', async () => {
    const result = await exec('rm -rf /', { restricted: true });
    expect(result.blocked).toBe(true);
    expect(result.exit_code).toBe(-1);
  });

  it('restricted mode blocks shutdown', async () => {
    const result = await exec('shutdown -h now', { restricted: true });
    expect(result.blocked).toBe(true);
  });

  it('restricted mode blocks reboot', async () => {
    const result = await exec('reboot', { restricted: true });
    expect(result.blocked).toBe(true);
  });

  it('restricted mode blocks iptables flush', async () => {
    const result = await exec('iptables -F', { restricted: true });
    expect(result.blocked).toBe(true);
  });

  it('restricted mode with network isolation blocks curl commands', async () => {
    const result = await exec('curl https://example.com', { restricted: true, networkIsolation: true });
    expect(result.blocked).toBe(true);
    expect(result.stderr).toContain('network isolation policy');
  });

  it('blocks obfuscated network attempts via shell child command', async () => {
    const result = await exec('sh -c "curl https://example.com"', { restricted: true, networkIsolation: true });
    expect(result.blocked).toBe(true);
    expect(result.stderr).toContain('network isolation policy');
  });

  it('blocks child-process style network escape attempts', async () => {
    const result = await exec('node -e "require(\'child_process\').execSync(\'curl https://example.com\')"', { restricted: true, networkIsolation: true });
    expect(result.blocked).toBe(true);
  });

  it('blocks encoded network payloads piped through base64 decode', async () => {
    const result = await exec('echo Y3VybCBodHRwczovL2V4YW1wbGUuY29t | base64 -d | sh', { restricted: true, networkIsolation: true });
    expect(result.blocked).toBe(true);
    expect(result.stderr).toContain('network isolation policy');
  });

  it('network isolation can be disabled explicitly', async () => {
    const result = await exec('echo curl', { restricted: true, networkIsolation: false });
    expect(result.blocked).toBe(false);
    expect(result.exit_code).toBe(0);
  });

  it('restricted mode allows safe commands', async () => {
    const result = await exec('echo safe', { restricted: true });
    expect(result.blocked).toBe(false);
    expect(result.stdout.trim()).toBe('safe');
  });

  it('restricted mode blocks commands outside allowlist', async () => {
    const result = await exec('unknown_bin --version', { restricted: true });
    expect(result.blocked).toBe(true);
    expect(result.stderr).toContain('allowlist');
  });

  it('non-restricted mode allows dangerous commands (but we test a safe one)', async () => {
    // Without restricted flag, the blocked check is skipped
    const result = await exec('echo "rm -rf /"', { restricted: false });
    expect(result.blocked).toBe(false);
    expect(result.exit_code).toBe(0);
  });

  it('cwd option changes working directory', async () => {
    const result = await exec('pwd', { cwd: '/tmp' });
    // macOS: /tmp is a symlink to /private/tmp, pwd resolves it
    expect(['/tmp', '/private/tmp']).toContain(result.stdout.trim());
    expect(result.exit_code).toBe(0);
  });

  it('elapsed_ms is tracked', async () => {
    const result = await exec('sleep 0.1');
    expect(result.elapsed_ms).toBeGreaterThanOrEqual(50);
  });

  // ---------------------------------------------------------------------------
  // Environment variable sanitization
  // ---------------------------------------------------------------------------

  afterEach(() => {
    // Clean up any test env vars and reset cache
    delete process.env.TEST_FAKE_API_KEY;
    delete process.env.MY_SECRET_TOKEN;
    delete process.env.DB_PASSWORD;
    delete process.env.SAFE_VARIABLE;
    resetSanitizedEnvCache();
  });

  it('strips *_API_KEY env vars from child process', async () => {
    process.env.TEST_FAKE_API_KEY = 'sk-secret-value-12345';
    resetSanitizedEnvCache();
    const result = await exec('env');
    expect(result.stdout).not.toContain('TEST_FAKE_API_KEY');
    expect(result.stdout).not.toContain('sk-secret-value-12345');
  });

  it('strips *_TOKEN env vars from child process', async () => {
    process.env.MY_SECRET_TOKEN = 'tok-secret-value';
    resetSanitizedEnvCache();
    const result = await exec('env');
    expect(result.stdout).not.toContain('MY_SECRET_TOKEN');
    expect(result.stdout).not.toContain('tok-secret-value');
  });

  it('strips *_PASSWORD env vars from child process', async () => {
    process.env.DB_PASSWORD = 'hunter2';
    resetSanitizedEnvCache();
    const result = await exec('env');
    expect(result.stdout).not.toContain('DB_PASSWORD');
    expect(result.stdout).not.toContain('hunter2');
  });

  it('preserves non-secret env vars in child process', async () => {
    process.env.SAFE_VARIABLE = 'visible-value';
    resetSanitizedEnvCache();
    const result = await exec('env');
    expect(result.stdout).toContain('SAFE_VARIABLE=visible-value');
  });
});

// ---------------------------------------------------------------------------
// Background process execution
// ---------------------------------------------------------------------------

describe('capabilities/shell — background processes', () => {
  afterAll(() => {
    // Clean up any leftover background processes
    killAllProcesses();
  });

  it('execBackground starts a process and returns process_id', async () => {
    const result = await execBackground('echo bg-hello');
    expect(result.process_id).toBeDefined();
    expect(typeof result.process_id).toBe('string');
    expect(result.process_id.length).toBeGreaterThan(0);
    expect(result.pid).toBeDefined();
  });

  it('getProcessStatus returns status for known process', async () => {
    const { process_id } = await execBackground('echo status-test');
    // Wait for process to finish
    await new Promise(r => setTimeout(r, 500));

    const status = getProcessStatus(process_id);
    expect(status).not.toBeNull();
    expect(status!.status).toBe('completed');
    expect(status!.exit_code).toBe(0);
    expect(status!.elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(status!.command).toBe('echo status-test');
  });

  it('getProcessStatus returns null for unknown process_id', () => {
    const status = getProcessStatus('nonexistent-id');
    expect(status).toBeNull();
  });

  it('getProcessOutput returns stdout from completed process', async () => {
    const { process_id } = await execBackground('echo output-test');
    await new Promise(r => setTimeout(r, 500));

    const output = getProcessOutput(process_id);
    expect(output).not.toBeNull();
    expect(output!.stdout.trim()).toBe('output-test');
  });

  it('getProcessOutput supports tail_lines', async () => {
    const { process_id } = await execBackground('printf "line1\\nline2\\nline3\\nline4\\nline5"');
    await new Promise(r => setTimeout(r, 500));

    const output = getProcessOutput(process_id, 2);
    expect(output).not.toBeNull();
    const lines = output!.stdout.split('\n').filter(Boolean);
    expect(lines.length).toBe(2);
    expect(lines).toContain('line4');
    expect(lines).toContain('line5');
  });

  it('getProcessOutput returns null for unknown process', () => {
    const output = getProcessOutput('nonexistent-id');
    expect(output).toBeNull();
  });

  it('sendProcessInput writes to stdin', async () => {
    const { process_id } = await execBackground('cat');
    await new Promise(r => setTimeout(r, 200));

    const result = sendProcessInput(process_id, 'hello stdin\n');
    expect(result.ok).toBe(true);

    // Give it time to process
    await new Promise(r => setTimeout(r, 300));
    const output = getProcessOutput(process_id);
    expect(output!.stdout).toContain('hello stdin');

    // Clean up
    killProcess(process_id);
  });

  it('sendProcessInput returns error for unknown process', () => {
    const result = sendProcessInput('nonexistent-id', 'test');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('sendProcessInput returns error for completed process', async () => {
    const { process_id } = await execBackground('echo done');
    await new Promise(r => setTimeout(r, 500));

    const result = sendProcessInput(process_id, 'too late');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('completed');
  });

  it('killProcess terminates a running process', async () => {
    const { process_id } = await execBackground('sleep 30');
    await new Promise(r => setTimeout(r, 200));

    const status1 = getProcessStatus(process_id);
    expect(status1!.status).toBe('running');

    const result = killProcess(process_id);
    expect(result.killed).toBe(true);

    const status2 = getProcessStatus(process_id);
    expect(status2!.status).toBe('killed');
  });

  it('killProcess returns error for unknown process', () => {
    const result = killProcess('nonexistent-id');
    expect(result.killed).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('killProcess returns error for already completed process', async () => {
    const { process_id } = await execBackground('echo done');
    await new Promise(r => setTimeout(r, 500));

    const result = killProcess(process_id);
    expect(result.killed).toBe(false);
    expect(result.error).toContain('already');
  });

  it('killAllProcesses kills processes by chatId', async () => {
    await execBackground('sleep 30', { chatId: 'chat-a', tenantId: 'default' });
    await execBackground('sleep 30', { chatId: 'chat-a', tenantId: 'default' });
    await execBackground('sleep 30', { chatId: 'chat-b', tenantId: 'default' });
    await new Promise(r => setTimeout(r, 200));

    const killed = killAllProcesses('chat-a');
    expect(killed).toBe(2);

    // chat-b should still be running
    killAllProcesses('chat-b');
  });

  it('exec() with background=true returns process_id', async () => {
    const result = await exec('echo bg-exec', { background: true });
    expect(result.blocked).toBe(false);
    expect(result.process_id).toBeDefined();
    expect(result.pid).toBeDefined();
    expect(result.stdout).toContain('Background process started');
  });

  it('exec() with background=true respects restricted mode', async () => {
    const result = await exec('rm -rf /', { background: true, restricted: true });
    expect(result.blocked).toBe(true);
    expect(result.process_id).toBeUndefined();
  });

  it('process exits with non-zero code sets status to failed', async () => {
    const { process_id } = await execBackground('exit 42');
    await new Promise(r => setTimeout(r, 500));

    const status = getProcessStatus(process_id);
    expect(status!.status).toBe('failed');
    expect(status!.exit_code).toBe(42);
  });

  describe('managed python overlay (Issue #702)', () => {
    const prevHome = process.env.MOZI_HOME;
    const prevPython = process.env.MOZI_PYTHON;
    let home: string;
    let overlay: string;

    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), 'mozi-shell-py-'));
      process.env.MOZI_HOME = home;
      const python = join(home, 'python3');
      writeFileSync(python, [
        '#!/bin/sh',
        `printf '%s\\n' '{"python_version":"3.11.9","implementation":"cpython","abi_tag":"cp311","platform":"macosx","arch":"arm64"}'`,
        '',
      ].join('\n'), 'utf8');
      chmodSync(python, 0o755);
      process.env.MOZI_PYTHON = python;
      overlay = join(home, 'skill-runtime', 'python', 'cp311-macosx-arm64');
      resetSanitizedEnvCache();
    });

    afterEach(() => {
      if (prevHome === undefined) delete process.env.MOZI_HOME; else process.env.MOZI_HOME = prevHome;
      if (prevPython === undefined) delete process.env.MOZI_PYTHON; else process.env.MOZI_PYTHON = prevPython;
      rmSync(home, { recursive: true, force: true });
      resetSanitizedEnvCache();
    });

    it('picks up an overlay provisioned after shell has already run', async () => {
      // The fresh-install ordering: the Brain runs a shell command before any
      // skill is activated, then use_skill provisions packages. Caching the
      // "no overlay yet" answer from the first command left every later command
      // unable to import packages that provisioning had just verified — while
      // MOZI told the Brain they were ready.
      const before = await exec('echo "PYTHONPATH=[$PYTHONPATH]"');
      expect(before.stdout).toContain('PYTHONPATH=[]');

      mkdirSync(overlay, { recursive: true });

      const after = await exec('echo "PYTHONPATH=[$PYTHONPATH]"');
      expect(after.stdout).toContain(`PYTHONPATH=[${overlay}]`);
    });

    it('replaces an inherited PYTHONPATH rather than appending to it', async () => {
      mkdirSync(overlay, { recursive: true });
      process.env.PYTHONPATH = '/host/conda/site-packages';
      process.env.PYTHONHOME = '/host/conda';
      resetSanitizedEnvCache();
      try {
        const result = await exec('echo "PP=[$PYTHONPATH] PH=[$PYTHONHOME]"');
        // A host tree left on the path is the vector that shadowed the bundled
        // interpreter with foreign-architecture packages.
        expect(result.stdout).toContain(`PP=[${overlay}]`);
        expect(result.stdout).toContain('PH=[]');
      } finally {
        delete process.env.PYTHONPATH;
        delete process.env.PYTHONHOME;
      }
    });

    it('recovers when the first interpreter probe fails transiently', async () => {
      // Memoizing a failed resolution would strand shell without an overlay for
      // the whole process, while the provisioner resolves independently,
      // succeeds, and reports the packages ready — the same readiness/execution
      // split reached from the other side.
      const marker = join(home, 'probe-attempted');
      const flaky = join(home, 'flaky-python');
      writeFileSync(flaky, [
        '#!/bin/sh',
        `if [ -f '${marker}' ]; then printf '%s\\n' '{"python_version":"3.11.9","implementation":"cpython","abi_tag":"cp311","platform":"macosx","arch":"arm64"}'; else : > '${marker}'; exit 1; fi`,
        '',
      ].join('\n'), 'utf8');
      chmodSync(flaky, 0o755);
      process.env.MOZI_PYTHON = flaky;
      mkdirSync(overlay, { recursive: true });
      resetSanitizedEnvCache();

      const first = await exec('echo "PYTHONPATH=[$PYTHONPATH]"');
      expect(first.stdout).toContain('PYTHONPATH=[]');

      const second = await exec('echo "PYTHONPATH=[$PYTHONPATH]"');
      expect(second.stdout).toContain(`PYTHONPATH=[${overlay}]`);
    });

    it('gives background commands the same overlay as foreground', async () => {
      mkdirSync(overlay, { recursive: true });
      const { process_id } = await execBackground('echo "PYTHONPATH=[$PYTHONPATH]"');
      await new Promise((r) => setTimeout(r, 300));
      const output = getProcessOutput(process_id);
      expect(output!.stdout).toContain(`PYTHONPATH=[${overlay}]`);
    });
  });
});
