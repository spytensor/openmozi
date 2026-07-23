/**
 * Runtime provider key resolution.
 *
 * Static provider config/env remains the highest-priority source. The local
 * tenant key store is the UI-managed fallback for the single-user runtime.
 */
import pino from 'pino';
import { resolveApiKey } from './providers.js';
import { getTenantApiKey } from '../security/tenant-keys.js';
import { resolveTenantMasterSecret } from '../security/secrets.js';

const logger = pino({ name: 'mozi:runtime-provider-keys' });

export interface RuntimeProviderKeyOptions {
  apiKey?: string;
  configProviders?: Record<string, { apikey?: string }>;
  tenantId?: string;
  masterSecret?: string;
}

/** Resolve the API key that runtime provider calls should actually use. */
export function resolveRuntimeApiKey(
  providerId: string,
  options: RuntimeProviderKeyOptions = {},
): string | undefined {
  const explicit = options.apiKey?.trim();
  if (explicit) return explicit;

  const configured = resolveApiKey(providerId, options.configProviders);
  if (configured) return configured;

  try {
    const masterSecret = options.masterSecret ?? resolveTenantMasterSecret();
    if (!masterSecret) return undefined;
    const tenantKey = getTenantApiKey(
      options.tenantId ?? 'default',
      providerId,
      masterSecret,
    );
    return tenantKey?.trim() || undefined;
  } catch (err) {
    // Some CLI/test paths build provider metadata before the DB is initialized.
    // In those cases env/config resolution above is still valid; the tenant
    // store is just unavailable.
    logger.debug(
      { provider: providerId, error: err instanceof Error ? err.message : String(err) },
      'Tenant provider key store unavailable during resolution',
    );
    return undefined;
  }
}

/** True when a provider has any runtime-usable API key. */
export function hasRuntimeApiKey(
  providerId: string,
  options: RuntimeProviderKeyOptions = {},
): boolean {
  return Boolean(resolveRuntimeApiKey(providerId, options));
}
