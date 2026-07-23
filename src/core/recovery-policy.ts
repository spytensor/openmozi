/**
 * Recovery Policy — Utility Functions
 * ------------------------------------
 * Provides env-key extraction for fallback messages.
 * The multi-phase recovery chain has been removed in favor of
 * trusting the LLM tool loop with simple safety nets (timeout, iteration cap).
 */

export type RecoveryLoopStopReason =
  | 'max_iterations'
  | 'loop_timeout'
  | 'loop_detected'
  | 'narration_without_execution'
  | 'empty_response';

const MISSING_ENV_PATTERNS = [
  /\b([A-Z][A-Z0-9_]{2,})\s+environment variable is not set\b/gi,
  /\benv(?:ironment)?\s+variable\s+([A-Z][A-Z0-9_]{2,})\s+(?:is )?missing\b/gi,
  /\bmissing environment variables?\s+([A-Z][A-Z0-9_,\s]{2,})\b/gi,
];

export function extractMissingEnvKeys(errors: string[]): string[] {
  const keys = new Set<string>();
  for (const error of errors) {
    for (const pattern of MISSING_ENV_PATTERNS) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(error)) !== null) {
        const key = match[1];
        if (!key) continue;
        const candidates = key
          .split(/[,\s]+/)
          .map((value) => value.trim())
          .filter((value) => /^[A-Z][A-Z0-9_]{2,}$/.test(value));
        for (const candidate of candidates) {
          keys.add(candidate);
        }
      }
      pattern.lastIndex = 0;
    }
  }
  return Array.from(keys).slice(0, 3);
}
