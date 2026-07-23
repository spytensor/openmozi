import type { Role } from './rbac.js';

const ROLE_ORDER: Record<Role, number> = {
  viewer: 0,
  operator: 1,
  admin: 2,
};

export const AUTH_COOKIE_NAME = 'mozi_token';

export function extractApiCredential(
  headers: Record<string, string | string[] | undefined>,
  cookies?: Record<string, string | undefined>,
): string | null {
  // Cookie takes priority (httpOnly, not accessible to JS)
  if (cookies) {
    const cookieToken = cookies[AUTH_COOKIE_NAME];
    if (typeof cookieToken === 'string' && cookieToken.trim().length > 0) {
      return cookieToken.trim();
    }
  }

  const rawApiKey = headers['x-api-key'];
  const apiKey = Array.isArray(rawApiKey) ? rawApiKey[0] : rawApiKey;
  if (typeof apiKey === 'string' && apiKey.trim().length > 0) {
    return apiKey.trim();
  }

  const rawAuth = headers.authorization ?? headers.Authorization;
  const auth = Array.isArray(rawAuth) ? rawAuth[0] : rawAuth;
  if (!auth || typeof auth !== 'string') return null;

  if (auth.startsWith('Bearer ')) {
    const token = auth.slice(7).trim();
    return token.length > 0 ? token : null;
  }

  if (auth.startsWith('ApiKey ')) {
    const key = auth.slice(7).trim();
    return key.length > 0 ? key : null;
  }

  return null;
}

export function isPublicApiRoute(method: string, routePath: string, authMode?: string): boolean {
  const normalizedMethod = method.toUpperCase();
  const normalizedPath = routePath.split('?')[0];
  return (
    (normalizedMethod === 'GET' && normalizedPath === '/api/health')
    || (normalizedMethod === 'GET' && normalizedPath === '/api/version')
    || (normalizedMethod === 'GET' && normalizedPath === '/api/office/file')
    || (normalizedMethod === 'GET' && normalizedPath === '/api/auth/status')
    || (normalizedMethod === 'POST' && normalizedPath === '/api/auth/pair')
    || (normalizedMethod === 'POST' && normalizedPath === '/api/auth/logout')
    // #230 OAuth2 endpoints — public (redirect-based flows)
    || (normalizedMethod === 'GET' && normalizedPath === '/api/auth/oauth/authorize')
    || (normalizedMethod === 'GET' && normalizedPath === '/api/auth/oauth/callback')
    // #232 Refresh token — uses httpOnly refresh cookie, no access token required
    || (normalizedMethod === 'POST' && normalizedPath === '/api/auth/refresh')
    || (authMode === 'local' && normalizedMethod === 'POST' && normalizedPath === '/api/auth/register')
    || (authMode === 'local' && normalizedMethod === 'POST' && normalizedPath === '/api/auth/login')
    // #234 SAML endpoints — public (browser redirect flows)
    || (normalizedMethod === 'GET' && normalizedPath === '/api/auth/saml/login')
    || (normalizedMethod === 'POST' && normalizedPath === '/api/auth/saml/acs')
    || (normalizedMethod === 'GET' && normalizedPath === '/api/auth/saml/metadata')
  );
}

export function requiredRoleForApiRoute(method: string, routePath: string): Role {
  const normalizedMethod = method.toUpperCase();
  const normalizedPath = routePath.split('?')[0];

  if (normalizedPath === '/api/auth/revoke') return 'admin';
  if (normalizedPath === '/api/auth/invites') return 'admin';
  if (normalizedPath === '/api/auth/logout') return 'viewer';
  if (normalizedPath === '/api/auth/password') return 'viewer';
  if (normalizedPath.startsWith('/api/config')) return 'admin';
  if (normalizedPath === '/api/coding-workers' && normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD') return 'admin';
  if (normalizedPath.startsWith('/api/audit')) return 'admin';
  // Tenant infrastructure — provider API keys, search key, model role slots,
  // brain selection, provider connectivity checks — is admin-only to write.
  // Non-admin users consume models through their entitlement grant instead.
  if (normalizedPath.startsWith('/api/keys') && normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD') return 'admin';
  if (normalizedPath === '/api/search-key' && normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD') return 'admin';
  if (normalizedPath.startsWith('/api/services') && normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD') return 'admin';
  if (normalizedPath === '/api/models/roles' && normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD') return 'admin';
  if (normalizedPath === '/api/brain') return 'admin';
  if (normalizedPath.startsWith('/api/providers/') && normalizedPath.endsWith('/check')) return 'admin';
  if (normalizedPath.startsWith('/api/providers/') && normalizedPath.endsWith('/models/manual')) return 'admin';
  if (normalizedPath === '/api/fs/roots' && normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD') return 'admin';
  if (normalizedPath === '/api/runtime/service' && normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD') return 'admin';
  // #231 User management
  if (normalizedPath === '/api/users' && normalizedMethod === 'GET') return 'admin';
  if (normalizedPath === '/api/users' && normalizedMethod === 'POST') return 'admin';
  if (normalizedPath === '/api/users/me') return 'viewer';
  if (
    normalizedPath.startsWith('/api/users/')
    && !normalizedPath.startsWith('/api/users/me')
    && (normalizedMethod === 'PATCH' || normalizedMethod === 'DELETE')
  ) return 'admin';
  // #233 Onboarding — any logged-in user
  if (normalizedPath.startsWith('/api/onboarding')) return 'viewer';
  // Personal task templates are user-owned resources. Every operation is
  // scoped by authenticated tenant + user at the data-access layer.
  if (normalizedPath.startsWith('/api/task-templates')) return 'viewer';
  if (normalizedMethod === 'GET' || normalizedMethod === 'HEAD') return 'viewer';
  if (normalizedMethod === 'POST' || normalizedMethod === 'PUT' || normalizedMethod === 'PATCH' || normalizedMethod === 'DELETE') {
    return 'operator';
  }
  return 'admin';
}

export function hasApiRole(required: Role, current: Role): boolean {
  return ROLE_ORDER[current] >= ROLE_ORDER[required];
}
