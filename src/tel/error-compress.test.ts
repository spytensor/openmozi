import { describe, it, expect } from 'vitest';
import { compress, summarize } from './error-compress.js';

describe('tel/error-compress', () => {
  it('extracts Python traceback info', () => {
    const stderr = `Traceback (most recent call last):
  File "test.py", line 42, in main
    x.foo()
AttributeError: object has no attribute foo`;

    const ctx = compress('shell', 'python test.py', 1, stderr);
    expect(ctx.error_type).toBe('AttributeError');
    expect(ctx.error_message).toBe('object has no attribute foo');
    expect(ctx.file).toBe('test.py');
    expect(ctx.line).toBe(42);
    expect(ctx.exit_code).toBe(1);
    expect(ctx.tool).toBe('shell');
    expect(ctx.command).toBe('python test.py');
  });

  it('extracts TypeScript compiler error', () => {
    const stderr = `src/index.ts(15,3): error TS2322: Type 'string' is not assignable to type 'number'.`;

    const ctx = compress('shell', 'tsc', 1, stderr);
    expect(ctx.error_type).toBe('TypeScriptError');
    expect(ctx.error_message).toBe("Type 'string' is not assignable to type 'number'.");
    expect(ctx.file).toBe('src/index.ts');
    expect(ctx.line).toBe(15);
  });

  it('extracts Node.js error', () => {
    const stderr = `TypeError: Cannot read properties of undefined (reading 'foo')
    at main (/app/index.js:10:5)
    at Object.<anonymous> (/app/index.js:20:1)`;

    const ctx = compress('shell', 'node index.js', 1, stderr);
    expect(ctx.error_type).toBe('TypeError');
    expect(ctx.error_message).toBe("Cannot read properties of undefined (reading 'foo')");
    expect(ctx.file).toBe('/app/index.js');
    expect(ctx.line).toBe(10);
  });

  it('handles empty stderr gracefully', () => {
    const ctx = compress('shell', 'some-cmd', 1, '');
    expect(ctx.error_type).toBeNull();
    expect(ctx.error_message).toBeNull();
    expect(ctx.file).toBeNull();
    expect(ctx.line).toBeNull();
    expect(ctx.stderr_tail).toBe('');
    expect(ctx.raw_length).toBe(0);
  });

  it('stderr_tail is last 20 lines capped at 2000 chars', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `Line ${i}`);
    const stderr = lines.join('\n');

    const ctx = compress('shell', 'cmd', 1, stderr);
    const tailLines = ctx.stderr_tail.split('\n');
    expect(tailLines.length).toBeLessThanOrEqual(20);
    expect(ctx.stderr_tail.length).toBeLessThanOrEqual(2000);
  });

  it('summarize produces readable summary', () => {
    const ctx = compress('shell', 'python test.py', 1,
      `Traceback (most recent call last):
  File "test.py", line 42, in main
    x.foo()
AttributeError: object has no attribute foo`
    );

    const summary = summarize(ctx);
    expect(summary).toContain('shell:python test.py failed');
    expect(summary).toContain('AttributeError');
    expect(summary).toContain('test.py:42');
  });

  it('summarize handles no error_type', () => {
    const ctx = compress('shell', 'some-cmd', 127, 'command not found');
    const summary = summarize(ctx);
    expect(summary).toContain('exit_code=127');
  });

  it('extracts Rust compiler error', () => {
    const stderr = `error[E0308]: mismatched types
 --> src/main.rs:5:20
  |
5 |     let x: i32 = "hello";
  |                   ^^^^^^^ expected i32, found &str`;

    const ctx = compress('shell', 'cargo build', 1, stderr);
    expect(ctx.error_type).toBe('RustCompilerError');
    expect(ctx.error_message).toBe('mismatched types');
    expect(ctx.file).toBe('src/main.rs');
    expect(ctx.line).toBe(5);
  });
});
