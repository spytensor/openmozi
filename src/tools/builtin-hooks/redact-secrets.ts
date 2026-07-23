/**
 * Reference `transform_tool_result` hook: redact common credential patterns
 * from tool output before the brain sees them. Serves as the bundled
 * example for the #259 plugin contract.
 *
 * Scope:
 *   - `ABC_API_KEY=secret`-style assignments (env / shell output)
 *   - `export FOO_TOKEN=secret` / `FOO_TOKEN: "secret"` variants
 *   - Bearer headers and Authorization headers
 *   - Standalone AWS-access-key format `AKIA…` (20 chars)
 *   - `-----BEGIN … PRIVATE KEY-----` blocks
 *
 * ## Placeholder protection (#265 review fix)
 *
 * The original implementation clobbered docs like `OPENAI_API_KEY=your-key-here`
 * — a user greppping their own config file would see `***REDACTED***` and
 * lose the ability to audit their setup. The rules below reject the
 * redaction when the captured value looks like a placeholder OR is shorter
 * than the minimum realistic secret length.
 *
 * Keep the ruleset deliberately small. The goal is a visible signal to the
 * brain that "this looks like a credential, don't echo it back"; not a
 * universal DLP.
 */
import type { ToolHook } from '../plugin.js';

type RedactionRule = {
  pattern: RegExp;
  /**
   * Return the replacement string, or `null` to skip the replacement
   * (leaves the original match in place). Lets rules peek at captured
   * values and opt out of redaction for placeholders.
   */
  replace: (match: string, ...groups: string[]) => string | null;
};

/** Real API tokens / passwords are almost always 16+ chars. */
const MIN_SECRET_LENGTH = 16;

/** Case-insensitive markers indicating the value is not a real secret. */
const PLACEHOLDER_RE = /(?:^|[-_])(your|my|a|the|paste|enter|insert|replace|change|todo|example|placeholder|changeme|change-me|change_me|replace-me|replace_me)([-_]|$)/i;
const PLACEHOLDER_PREFIX_RE = /^(?:<[^>]*>|\*\*\*|\.\.\.|xxx+|\[.*\])/i;
const PLACEHOLDER_SUFFIX_RE = /(?:-here|_here|-placeholder|_placeholder)$/i;

function looksLikePlaceholder(value: string): boolean {
  // Strip surrounding quotes that our regex may have left intact.
  const clean = value.replace(/^["']|["']$/g, '');
  if (clean.length < MIN_SECRET_LENGTH) return true;
  if (PLACEHOLDER_PREFIX_RE.test(clean)) return true;
  if (PLACEHOLDER_SUFFIX_RE.test(clean)) return true;
  if (PLACEHOLDER_RE.test(clean)) return true;
  return false;
}

const RULES: RedactionRule[] = [
  // KEY=VALUE / KEY: VALUE assignments for anything that *smells* like a secret.
  // Capture the VALUE too so we can skip placeholders.
  {
    pattern: /([A-Z][A-Z0-9_]*(?:_API_KEY|_KEY|_TOKEN|_SECRET|_PASSWORD|_PASSWD|_PWD))(\s*[:=]\s*["']?)([^\s"'\n]+)/g,
    replace: (match, key: string, _sep: string, value: string) => {
      if (looksLikePlaceholder(value)) return null;
      return `${key}=***REDACTED***`;
    },
  },
  // `export KEY="..."` — shell export form
  {
    pattern: /(export\s+[A-Z][A-Z0-9_]*(?:_API_KEY|_KEY|_TOKEN|_SECRET|_PASSWORD|_PASSWD|_PWD))(\s*=\s*["']?)([^\s"'\n]+)/g,
    replace: (match, prefix: string, _sep: string, value: string) => {
      if (looksLikePlaceholder(value)) return null;
      return `${prefix}=***REDACTED***`;
    },
  },
  // Authorization: Bearer <token>
  {
    pattern: /(Authorization\s*:\s*Bearer\s+)(\S+)/gi,
    replace: (match, prefix: string, value: string) => {
      if (looksLikePlaceholder(value)) return null;
      return `${prefix}***REDACTED***`;
    },
  },
  // AWS access keys — always 20 chars, never legitimately a placeholder.
  {
    pattern: /AKIA[0-9A-Z]{16}/g,
    replace: () => 'AKIA***REDACTED***',
  },
  // PEM-encoded private keys — never legitimately a placeholder.
  {
    pattern: /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
    replace: () => '-----BEGIN PRIVATE KEY-----\n***REDACTED***\n-----END PRIVATE KEY-----',
  },
];

export function redactSecretsInText(content: string): string {
  let out = content;
  for (const rule of RULES) {
    out = out.replace(rule.pattern, (match, ...groups) => {
      const replacement = rule.replace(match, ...groups);
      return replacement ?? match;
    });
  }
  return out;
}

export const redactSecretsHook: ToolHook = {
  id: 'builtin.redact-secrets',
  phase: 'transform_tool_result',
  priority: 10, // run early so later hooks see already-redacted content
  handler: (ctx) => {
    if (!ctx.result) return { kind: 'continue' };
    const next = redactSecretsInText(ctx.result.content);
    if (next === ctx.result.content) return { kind: 'continue' };
    return {
      kind: 'rewrite',
      result: { ...ctx.result, content: next },
    };
  },
};
