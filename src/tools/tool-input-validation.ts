import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import type { ToolDefinition } from '../core/llm.js';

const ajv = new Ajv({ allErrors: true, strict: false });
const validatorCache = new WeakMap<ToolDefinition, ValidateFunction>();
const MAX_ERROR_DETAILS = 4;

export type ToolArgumentValidationResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; message: string };

function asPlainObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function placeholderForSchema(schema: unknown): unknown {
  const row = asPlainObject(schema);
  if (!row) return 'value';
  if (Array.isArray(row.enum) && row.enum.length > 0) return row.enum[0];
  if (row.type === 'number' || row.type === 'integer') return 0;
  if (row.type === 'boolean') return false;
  if (row.type === 'array') return [];
  if (row.type === 'object') return buildExampleFromSchema(row);
  return 'value';
}

function buildExampleFromSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = asPlainObject(schema.properties) ?? {};
  const required = Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === 'string')
    : [];
  const example: Record<string, unknown> = {};
  for (const key of required.slice(0, 6)) {
    example[key] = placeholderForSchema(properties[key]);
  }
  return example;
}

function exampleForTool(tool: ToolDefinition): string {
  if (tool.function.name === 'create_artifact') {
    return '{"title":"Report","content_type":"markdown","code":"# Report"}';
  }
  return JSON.stringify(buildExampleFromSchema(tool.function.parameters));
}

function compactAjvError(error: ErrorObject): string {
  const path = error.instancePath || '/';
  if (error.keyword === 'required') {
    const property = String((error.params as { missingProperty?: unknown }).missingProperty ?? 'unknown');
    return `"${property.slice(0, 80)}" parameter is required`;
  }
  if (error.keyword === 'additionalProperties') {
    const property = String((error.params as { additionalProperty?: unknown }).additionalProperty ?? 'unknown');
    return `${path} has unsupported property "${property.slice(0, 80)}"`;
  }
  return `${path} ${error.message ?? 'is invalid'}`;
}

function validationFailure(tool: ToolDefinition, problems: string[]): ToolArgumentValidationResult {
  const detail = problems.slice(0, MAX_ERROR_DETAILS).join('; ');
  return {
    ok: false,
    message: `Error: Invalid arguments for tool "${tool.function.name}". ${detail}. Expected example: ${exampleForTool(tool)}`,
  };
}

function validatorFor(tool: ToolDefinition): ValidateFunction {
  const cached = validatorCache.get(tool);
  if (cached) return cached;
  const validator = ajv.compile(tool.function.parameters);
  validatorCache.set(tool, validator);
  return validator;
}

/**
 * Parse the outer JSON envelope of model-provided tool arguments *without*
 * enforcing the tool's schema.
 *
 * Split from `parseAndValidateToolArguments` so the executor can check the
 * JSON/object boundary before the permission gate (cheap, and a denied call
 * should report the denial rather than a schema complaint) while still naming
 * the tool and showing a valid example when it rejects. Passing `undefined` here
 * used to be the only way to skip schema validation, which also erased the tool
 * name from the message — producing `tool "unknown"` with no example, so a weak
 * model had nothing to repair against and simply retried the same malformed call.
 */
export function parseToolArgumentsEnvelope(
  rawArguments: string,
  tool: ToolDefinition | undefined,
): ToolArgumentValidationResult {
  const name = tool?.function.name ?? 'unknown';
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments);
  } catch {
    const expected = tool ? ` Expected example: ${exampleForTool(tool)}` : '';
    return {
      ok: false,
      message: `Error: Invalid JSON arguments for tool "${name}". Expected one JSON object.${expected}`,
    };
  }

  // Some providers double-encode the arguments, emitting a JSON *string* whose
  // contents are the real JSON object. Unwrap exactly one layer, and only when
  // it resolves to an object: more layers, or a string that merely looks
  // JSON-ish, stay an error rather than a guess about model intent.
  if (typeof parsed === 'string') {
    try {
      const unwrapped = JSON.parse(parsed);
      if (asPlainObject(unwrapped)) parsed = unwrapped;
    } catch {
      // Not double-encoded; fall through to the normal object-shape error.
    }
  }

  const args = asPlainObject(parsed);
  if (!args) {
    const expected = tool ? ` Expected example: ${exampleForTool(tool)}` : '';
    return {
      ok: false,
      message: `Error: Invalid arguments for tool "${name}": expected a JSON object, received ${Array.isArray(parsed) ? 'array' : typeof parsed}.${expected}`,
    };
  }

  return { ok: true, args };
}

/** Parse model-provided tool arguments and enforce the registered JSON Schema. */
export function parseAndValidateToolArguments(
  rawArguments: string,
  tool: ToolDefinition | undefined,
): ToolArgumentValidationResult {
  const envelope = parseToolArgumentsEnvelope(rawArguments, tool);
  if (!envelope.ok) return envelope;
  return validateToolArguments(envelope.args, tool);
}

/** Validate already-parsed object arguments against a registered tool schema. */
export function validateToolArguments(
  args: Record<string, unknown>,
  tool: ToolDefinition | undefined,
): ToolArgumentValidationResult {
  if (!tool) return { ok: true, args };
  try {
    const validator = validatorFor(tool);
    if (!validator(args)) {
      return validationFailure(tool, (validator.errors ?? []).map(compactAjvError));
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: `Error: Registered schema for tool "${tool.function.name}" is invalid: ${detail.slice(0, 300)}`,
    };
  }

  return { ok: true, args };
}
