import { describe, it, expect } from 'vitest';
import { redactSecretsInText, redactSecretsHook } from './redact-secrets.js';

// Realistic fake secrets (≥ 16 chars, no placeholder markers) used to assert
// the redactor acts on values that look like real credentials.
const FAKE_OPENAI = ['sk', 'abc1234567890abc1234567890abc1234567890abc'].join('-');
const FAKE_GITHUB = ['ghp', '1234567890abcdefghijklmnopqrstuvwxyz1234'].join('_');
const FAKE_ANTHROPIC = ['sk', 'ant', 'api', '1234567890abcdefghijklmnopqrstuvwxyz'].join('-');
const FAKE_BEARER = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.longtokenbody';

describe('builtin-hooks/redact-secrets - text rules', () => {
  it('redacts FOO_API_KEY= assignments (realistic value)', () => {
    expect(redactSecretsInText(`OPENAI_API_KEY=${FAKE_OPENAI}\nok`))
      .toContain('OPENAI_API_KEY=***REDACTED***');
  });

  it('redacts TOKEN / SECRET / PASSWORD variants (realistic values)', () => {
    const longPwd = 'hunter2-long-and-random-enough';
    expect(redactSecretsInText(`GITHUB_TOKEN=${FAKE_GITHUB}`))
      .toContain('GITHUB_TOKEN=***REDACTED***');
    expect(redactSecretsInText(`DB_PASSWORD=${longPwd}`))
      .toContain('DB_PASSWORD=***REDACTED***');
    expect(redactSecretsInText(`SESSION_SECRET=${FAKE_OPENAI}`))
      .toContain('SESSION_SECRET=***REDACTED***');
  });

  it('redacts export-form shell assignments', () => {
    expect(redactSecretsInText(`export ANTHROPIC_API_KEY=${FAKE_ANTHROPIC}\n`))
      .toContain('export ANTHROPIC_API_KEY=***REDACTED***');
  });

  it('redacts Authorization Bearer header (realistic token)', () => {
    const out = redactSecretsInText(`Authorization: Bearer ${FAKE_BEARER}\nmore`);
    expect(out).toContain('Authorization: Bearer ***REDACTED***');
    expect(out).not.toContain(FAKE_BEARER);
  });

  it('redacts AWS access key IDs (always — placeholder detection does not apply)', () => {
    expect(redactSecretsInText('AKIAIOSFODNN7EXAMPLE user')).toContain('AKIA***REDACTED***');
  });

  it('redacts PEM private key blocks (always — placeholder detection does not apply)', () => {
    const pem = [
      ['-----BEGIN RSA', 'PRIVATE KEY-----'].join(' '),
      'secretlinesgoherethatnobodyshouldsee',
      'moresecretlines',
      ['-----END RSA', 'PRIVATE KEY-----'].join(' '),
    ].join('\n');
    const out = redactSecretsInText(`before\n${pem}\nafter`);
    expect(out).toContain('before');
    expect(out).toContain('after');
    expect(out).not.toContain('secretlinesgoherethatnobodyshouldsee');
  });

  it('leaves benign content unchanged', () => {
    const plain = 'Hello world, no secrets here.\nPATH=/usr/local/bin';
    expect(redactSecretsInText(plain)).toBe(plain);
  });

  // --- #265 review: placeholder protection ---
  describe('placeholder protection (#265 review fix)', () => {
    it('does NOT redact `OPENAI_API_KEY=your-key-here`', () => {
      const docLine = 'OPENAI_API_KEY=your-key-here';
      expect(redactSecretsInText(docLine)).toBe(docLine);
    });

    it('does NOT redact `ANTHROPIC_API_KEY=<your-key>`', () => {
      const docLine = 'ANTHROPIC_API_KEY=<your-key>';
      expect(redactSecretsInText(docLine)).toBe(docLine);
    });

    it('does NOT redact assignments with value < 16 chars (too short to be a real secret)', () => {
      const shortLines = [
        'DEBUG_KEY=abc',
        'OPENAI_API_KEY=sk-short',
        'GITHUB_TOKEN=hunter2',
      ];
      for (const line of shortLines) {
        expect(redactSecretsInText(line)).toBe(line);
      }
    });

    it('does NOT redact common placeholder markers', () => {
      const placeholders = [
        'API_KEY=xxx-xxx-xxx-xxx',
        'API_KEY=***-***-***-***',
        'API_KEY=placeholder-placeholder',
        'API_KEY=change-me-please-really',
        'API_KEY=todo-insert-real-key-here',
      ];
      for (const line of placeholders) {
        expect(redactSecretsInText(line)).toBe(line);
      }
    });

    it('does NOT redact `Authorization: Bearer <your-token>` placeholder', () => {
      const docLine = 'Authorization: Bearer <your-token>';
      expect(redactSecretsInText(docLine)).toBe(docLine);
    });

    it('still redacts the surrounding real secret when a nearby placeholder exists', () => {
      const mixed = [
        'OPENAI_API_KEY=your-key-here      # example',
        `OPENAI_API_KEY=${FAKE_OPENAI}`,
      ].join('\n');
      const out = redactSecretsInText(mixed);
      expect(out).toContain('OPENAI_API_KEY=your-key-here');     // placeholder survived
      expect(out).toContain('OPENAI_API_KEY=***REDACTED***');    // real redacted
      expect(out).not.toContain(FAKE_OPENAI);
    });
  });
});

describe('builtin-hooks/redact-secrets - hook shape', () => {
  it('is a transform_tool_result hook with priority 10', () => {
    expect(redactSecretsHook.phase).toBe('transform_tool_result');
    expect(redactSecretsHook.priority).toBe(10);
    expect(redactSecretsHook.id).toBe('builtin.redact-secrets');
  });

  it('returns rewrite when content changes', async () => {
    const result = await redactSecretsHook.handler({
      toolName: 'shell_exec',
      args: {},
      tenantId: 'default',
      result: {
        tool_call_id: 'c1',
        tool_name: 'shell_exec',
        content: `OPENAI_API_KEY=${FAKE_OPENAI}\nrest`,
        is_error: false,
      },
    });
    expect(result.kind).toBe('rewrite');
    if (result.kind !== 'rewrite') return;
    expect(result.result!.content).toContain('OPENAI_API_KEY=***REDACTED***');
    expect(result.result!.is_error).toBe(false); // hook must NEVER touch is_error
  });

  it('returns continue when no pattern matches', async () => {
    const result = await redactSecretsHook.handler({
      toolName: 'shell_exec',
      args: {},
      tenantId: 'default',
      result: {
        tool_call_id: 'c1',
        tool_name: 'shell_exec',
        content: 'nothing sensitive here',
        is_error: false,
      },
    });
    expect(result.kind).toBe('continue');
  });

  it('returns continue when content contains only placeholders (not real secrets)', async () => {
    const result = await redactSecretsHook.handler({
      toolName: 'read_file',
      args: {},
      tenantId: 'default',
      result: {
        tool_call_id: 'c1',
        tool_name: 'read_file',
        content: 'OPENAI_API_KEY=your-key-here\nGITHUB_TOKEN=<your-token>',
        is_error: false,
      },
    });
    expect(result.kind).toBe('continue');
  });
});
