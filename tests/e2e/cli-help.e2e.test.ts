import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

describe('e2e/cli-help', () => {
  it('prints command help from the built CLI entrypoint', () => {
    const cliPath = resolve(process.cwd(), 'dist', 'cli.js');

    const result = spawnSync(process.execPath, [cliPath, '--help'], {
      encoding: 'utf-8',
      env: { ...process.env, MOZI_MODE: '' },
    });

    expect(result.status).toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toContain('MOZI');
    expect(output).toContain('Usage: mozi <command>');
  });
});
