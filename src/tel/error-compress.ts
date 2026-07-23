// ---------------------------------------------------------------------------
// Error Context Compression
//
// Rule-based extraction of error information from tool output.
// No LLM calls — pure regex + heuristics.
// Output: structured ErrorContext object (<500 tokens).
// ---------------------------------------------------------------------------

export interface ErrorContext {
  tool: string;
  command: string;
  exit_code: number;
  error_type: string | null;
  error_message: string | null;
  file: string | null;
  line: number | null;
  stderr_tail: string;
  raw_length: number;
}

// ---------------------------------------------------------------------------
// Extraction patterns
// ---------------------------------------------------------------------------

// Python traceback
const PYTHON_TRACEBACK_RE = /File "([^"]+)", line (\d+)/g;
const PYTHON_ERROR_RE = /^(\w+Error): (.+)$/m;

// Node.js / JavaScript
const NODE_STACK_RE = /at .+ \((.+):(\d+):\d+\)/;
const NODE_ERROR_RE = /^(\w*Error): (.+)$/m;

// Generic error type:message
const GENERIC_ERROR_RE = /^([\w.]+(?:Error|Exception|Fault))[:\s]+(.+)$/m;

// TypeScript compiler error
const TS_ERROR_RE = /^(.+)\((\d+),\d+\): error TS\d+: (.+)$/m;

// Rust compiler error
const RUST_ERROR_RE = /error\[E\d+\]: (.+)\n\s+--> (.+):(\d+):\d+/;

// Shell exit code
const EXIT_CODE_RE = /exit (?:code|status)[:\s]+(\d+)/i;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compress raw error output into a structured ErrorContext.
 *
 * @param tool     - Tool that produced the error (e.g. 'shell')
 * @param command  - The command that was executed
 * @param exitCode - Process exit code
 * @param stderr   - Raw stderr output
 * @returns Structured error context
 */
export function compress(tool: string, command: string, exitCode: number, stderr: string): ErrorContext {
  const lines = stderr.split('\n');
  const tailLines = lines.slice(-20).join('\n').trim();

  let errorType: string | null = null;
  let errorMessage: string | null = null;
  let file: string | null = null;
  let line: number | null = null;

  // Try Python traceback (only use Python error regex if traceback was found)
  const pyTraceMatches = [...stderr.matchAll(PYTHON_TRACEBACK_RE)];
  if (pyTraceMatches.length > 0) {
    const last = pyTraceMatches[pyTraceMatches.length - 1];
    file = last[1];
    line = parseInt(last[2], 10);

    const pyErrorMatch = stderr.match(PYTHON_ERROR_RE);
    if (pyErrorMatch) {
      errorType = pyErrorMatch[1];
      errorMessage = pyErrorMatch[2];
    }
  }

  // Try TypeScript error
  if (!errorType) {
    const tsMatch = stderr.match(TS_ERROR_RE);
    if (tsMatch) {
      file = tsMatch[1];
      line = parseInt(tsMatch[2], 10);
      errorType = 'TypeScriptError';
      errorMessage = tsMatch[3];
    }
  }

  // Try Node.js stack trace
  if (!errorType) {
    const nodeErrorMatch = stderr.match(NODE_ERROR_RE);
    if (nodeErrorMatch) {
      errorType = nodeErrorMatch[1];
      errorMessage = nodeErrorMatch[2];
    }
    const nodeStackMatch = stderr.match(NODE_STACK_RE);
    if (nodeStackMatch && !file) {
      file = nodeStackMatch[1];
      line = parseInt(nodeStackMatch[2], 10);
    }
  }

  // Try Rust error
  if (!errorType) {
    const rustMatch = stderr.match(RUST_ERROR_RE);
    if (rustMatch) {
      errorType = 'RustCompilerError';
      errorMessage = rustMatch[1];
      file = rustMatch[2];
      line = parseInt(rustMatch[3], 10);
    }
  }

  // Try generic error pattern
  if (!errorType) {
    const genericMatch = stderr.match(GENERIC_ERROR_RE);
    if (genericMatch) {
      errorType = genericMatch[1];
      errorMessage = genericMatch[2];
    }
  }

  // Try exit code from text
  if (exitCode === 0) {
    const exitMatch = stderr.match(EXIT_CODE_RE);
    if (exitMatch) {
      // Override if stderr mentions a non-zero exit code
    }
  }

  return {
    tool,
    command,
    exit_code: exitCode,
    error_type: errorType,
    error_message: errorMessage,
    file,
    line,
    stderr_tail: tailLines.slice(0, 2000),  // Cap to ~500 tokens
    raw_length: stderr.length,
  };
}

/**
 * Create a short summary string for Brain consumption (<100 tokens).
 */
export function summarize(ctx: ErrorContext): string {
  const parts = [`${ctx.tool}:${ctx.command} failed`];
  if (ctx.error_type) {
    parts.push(`(${ctx.error_type}`);
    if (ctx.file && ctx.line) parts.push(`at ${ctx.file}:${ctx.line}`);
    parts.push(')');
  } else {
    parts.push(`(exit_code=${ctx.exit_code})`);
  }
  if (ctx.error_message) {
    const truncated = ctx.error_message.length > 100 ? ctx.error_message.slice(0, 100) + '...' : ctx.error_message;
    parts.push(`— ${truncated}`);
  }
  return parts.join(' ');
}
