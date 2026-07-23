import { describe, expect, it } from 'vitest';
import { ALL_TOOLS } from './definitions.js';
import { parseAndValidateToolArguments, parseToolArgumentsEnvelope } from './tool-input-validation.js';

function tool(name: string) {
  const definition = ALL_TOOLS.find((candidate) => candidate.function.name === name);
  if (!definition) throw new Error(`Missing tool definition: ${name}`);
  return definition;
}

describe('tool input validation', () => {
  it('rejects a JSON string instead of treating its characters as object keys', () => {
    const result = parseAndValidateToolArguments(JSON.stringify('# Long markdown report'), tool('create_artifact'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('expected a JSON object, received string');
    expect(result.message).toContain('{"title":"Report","content_type":"markdown","code":"# Report"}');
    expect(result.message).not.toContain('Received keys: [0, 1, 2');
    expect(result.message.length).toBeLessThan(500);
  });

  it('accepts canonical and backward-compatible create_artifact inputs', () => {
    expect(parseAndValidateToolArguments(JSON.stringify({
      title: 'Report', content_type: 'markdown', code: '# Report',
    }), tool('create_artifact')).ok).toBe(true);
    expect(parseAndValidateToolArguments(JSON.stringify({
      name: 'Report', markdown: '# Report',
    }), tool('create_artifact')).ok).toBe(true);
  });

  it('rejects missing required fields and unsupported properties with compact feedback', () => {
    const missing = parseAndValidateToolArguments(JSON.stringify({ title: 'Report' }), tool('create_artifact'));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.message).toContain('"code" parameter is required');

    const extra = parseAndValidateToolArguments(JSON.stringify({
      title: 'Report', code: '# Report', surprise: true,
    }), tool('create_artifact'));
    expect(extra.ok).toBe(false);
    if (!extra.ok) expect(extra.message).toContain('unsupported property "surprise"');
  });

  it('can compile every built-in tool schema', () => {
    for (const definition of ALL_TOOLS) {
      const result = parseAndValidateToolArguments('{}', definition);
      if (!result.ok) {
        expect(result.message, definition.function.name).not.toContain('Registered schema for');
      }
    }
  });
});

/**
 * The outer boundary is checked before the permission gate, so it deliberately
 * skips schema validation. It must still name the tool and show an example: a
 * weak model that gets `tool "unknown"` with no example has nothing to repair
 * against and simply retries the identical malformed call (Issue #702).
 */
describe('tool argument envelope', () => {
  it('names the tool and shows an example without enforcing the schema', () => {
    const result = parseToolArgumentsEnvelope(JSON.stringify('{"path": "/tmp/x"}'), tool('write_file'));
    expect(result.ok).toBe(true);
  });

  it('keeps the real tool name when arguments are not an object', () => {
    const result = parseToolArgumentsEnvelope(JSON.stringify(['a', 'b']), tool('write_file'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('"write_file"');
    expect(result.message).not.toContain('"unknown"');
    expect(result.message).toContain('Expected example:');
  });

  it('keeps the real tool name when the arguments are not valid JSON', () => {
    const result = parseToolArgumentsEnvelope('{not json', tool('write_file'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('"write_file"');
    expect(result.message).not.toContain('"unknown"');
  });

  it('normalizes one layer of double-encoded JSON arguments', () => {
    // Some providers emit a JSON string whose contents are the real object.
    const inner = { path: '/tmp/report.py', content: 'print(1)' };
    const result = parseToolArgumentsEnvelope(JSON.stringify(JSON.stringify(inner)), tool('write_file'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.args).toEqual(inner);
  });

  it('does not unwrap a plain string that is not an encoded object', () => {
    // Unwrapping must never guess at intent: a bare string stays an error.
    const result = parseToolArgumentsEnvelope(JSON.stringify('# Long markdown report'), tool('create_artifact'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('expected a JSON object, received string');
  });

  it('does not unwrap a double-encoded non-object', () => {
    const result = parseToolArgumentsEnvelope(JSON.stringify(JSON.stringify([1, 2])), tool('write_file'));
    expect(result.ok).toBe(false);
  });

  it('only unwraps a single layer', () => {
    const triple = JSON.stringify(JSON.stringify(JSON.stringify({ path: '/tmp/x' })));
    const result = parseToolArgumentsEnvelope(triple, tool('write_file'));
    expect(result.ok).toBe(false);
  });

  it('still degrades to "unknown" for a tool that is not registered', () => {
    const result = parseToolArgumentsEnvelope('{not json', undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('"unknown"');
  });
});
