import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { resolveCliPromptDelivery, writeCliPromptToStdin } from './cli-prompt-delivery.js';

const backend = {
  input: 'arg' as const,
  maxPromptArgBytes: 65_536,
};

describe('cli prompt delivery', () => {
  it('uses argv below the byte threshold and stdin at the boundary', () => {
    const below = resolveCliPromptDelivery('a'.repeat(65_535), backend);
    expect(below).toMatchObject({ mode: 'arg', promptArgs: ['a'.repeat(65_535)] });

    const boundary = resolveCliPromptDelivery('a'.repeat(65_536), backend);
    expect(boundary.mode).toBe('stdin');
    expect(boundary.promptArgs).toEqual([]);
    expect(boundary.stdinPayload).toBe('a'.repeat(65_536));
  });

  it('measures UTF-8 bytes for CJK and emoji prompts', () => {
    const cjk = '中'.repeat(30_000);
    expect(cjk.length).toBeLessThan(65_536);
    expect(resolveCliPromptDelivery(cjk, backend).mode).toBe('stdin');

    const emojiBoundary = `${'a'.repeat(65_532)}😀`;
    expect(Buffer.byteLength(emojiBoundary, 'utf8')).toBe(65_536);
    expect(resolveCliPromptDelivery(emojiBoundary, backend).mode).toBe('stdin');
  });

  it('uses backend-specific stdin args without putting the prompt in argv', () => {
    const prompt = 'x'.repeat(65_536);
    expect(resolveCliPromptDelivery(prompt, { ...backend, stdinPromptArgs: ['-'] })).toEqual({
      mode: 'stdin', promptArgs: ['-'], stdinPayload: prompt,
    });
    expect(resolveCliPromptDelivery(prompt, { ...backend, stdinPromptArgs: ['-p', ''] })).toEqual({
      mode: 'stdin', promptArgs: ['-p', ''], stdinPayload: prompt,
    });
  });

  it('streams more than one MiB byte-identically to a real child process', async () => {
    const payload = `${'中'.repeat(400_000)}\nlarge-prompt`;
    const expected = `${Buffer.byteLength(payload, 'utf8')}:${createHash('sha256').update(payload).digest('hex')}`;
    const script = [
      "const { createHash } = require('node:crypto');",
      'const chunks = [];',
      "process.stdin.on('data', chunk => chunks.push(chunk));",
      "process.stdin.on('end', () => { const body = Buffer.concat(chunks); process.stdout.write(`${body.length}:${createHash('sha256').update(body).digest('hex')}`); });",
    ].join('');
    const child = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    writeCliPromptToStdin(child.stdin, payload, error => child.emit('error', error));

    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve() : reject(new Error(`fixture exited ${code}`)));
    });

    expect(Buffer.concat(stdout).toString()).toBe(expected);
  });
});
