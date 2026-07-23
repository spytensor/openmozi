export type DesktopAction = 'retry' | 'restart' | 'open-log';

export function runtimeOrigin(runtimeUrl: string): string | null {
  try {
    return new URL(runtimeUrl).origin;
  } catch {
    return null;
  }
}

export function isRuntimeResourceUrl(url: string, runtimeUrl: string): boolean {
  const expectedOrigin = runtimeOrigin(runtimeUrl);
  if (!expectedOrigin) return false;
  try {
    const candidate = new URL(url);
    if (candidate.protocol === 'blob:') {
      return candidate.origin === expectedOrigin;
    }
    return candidate.origin === expectedOrigin && (candidate.protocol === 'http:' || candidate.protocol === 'https:');
  } catch {
    return false;
  }
}

export function isSafeExternalUrl(url: string): boolean {
  try {
    return ['http:', 'https:', 'mailto:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

export function desktopActionFromUrl(url: string): DesktopAction | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'mozi-action:') return null;
    const action = parsed.hostname || parsed.pathname.replace(/^\/+/, '');
    return action === 'retry' || action === 'restart' || action === 'open-log' ? action : null;
  } catch {
    return null;
  }
}

export function sanitizeDesktopError(error: unknown): string {
  const input = error instanceof Error ? error.message : String(error);
  return input
    .replace(/(authorization\s*:\s*bearer\s+)[^\s"']+/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key|token|secret)\s*[=:]\s*)[^\s,"'}]+/gi, '$1[redacted]')
    .replace(/"request_id"\s*:\s*"[^"]*"/gi, '"request_id":"[redacted]"')
    .slice(0, 1_000);
}
