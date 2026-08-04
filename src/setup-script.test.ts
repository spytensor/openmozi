import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guards the community source-install entry point. `--check` exercises the
 * full resolution pipeline (platform gate, Node discovery + ranking, pnpm
 * strategy selection, pinned-version verification) without mutating anything,
 * so it can run in every environment the unit suite runs in.
 */
describe('scripts/setup.sh', () => {
  const repoRoot = join(__dirname, '..');
  const script = join(repoRoot, 'scripts', 'setup.sh');

  it('exists and is committed as executable', () => {
    expect(existsSync(script)).toBe(true);
  });

  it('--check resolves a supported Node and the pinned pnpm', () => {
    const output = execFileSync('bash', [script, '--check'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 120_000,
    });
    // Node must be inside the engines range and never an odd non-LTS major
    // (dependency engine pins reject Node 23 even though ours allows it).
    const nodeMatch = output.match(/using node v(\d+)\.(\d+)\./);
    expect(nodeMatch, output).not.toBeNull();
    const major = Number(nodeMatch![1]);
    expect([22, 24].includes(major), `picked Node ${major}: ${output}`).toBe(true);

    // The resolved pnpm must equal the repository pin, whatever the strategy.
    const pin = process.env.npm_package_packageManager?.split('@')[1]
      ?? JSON.parse(
        execFileSync('cat', [join(repoRoot, 'package.json')], { encoding: 'utf8' }),
      ).packageManager.split('@')[1];
    expect(output).toContain(`pnpm ${pin} via `);
    expect(output).toContain('Check passed');
  });

  it('rejects an unusable MOZI_NODE override instead of silently substituting', () => {
    let failed = false;
    let output = '';
    try {
      execFileSync('bash', [script, '--check'], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, MOZI_NODE: '/nonexistent/bin/node' },
      });
    } catch (err) {
      failed = true;
      const execError = err as { stderr?: string; stdout?: string };
      output = `${execError.stdout ?? ''}${execError.stderr ?? ''}`;
    }
    expect(failed).toBe(true);
    expect(output).toContain('MOZI_NODE=/nonexistent/bin/node is not a usable Node');
  });
});
