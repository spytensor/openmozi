import { describe, expect, it } from 'vitest';
import {
  AUTH_COOKIE_NAME,
  extractApiCredential,
  hasApiRole,
  isPublicApiRoute,
  requiredRoleForApiRoute,
} from './api-auth.js';

describe('security/api-auth', () => {
  it('extracts bearer token and x-api-key credentials', () => {
    expect(extractApiCredential({ authorization: 'Bearer abc.jwt.token' })).toBe('abc.jwt.token');
    expect(extractApiCredential({ Authorization: 'ApiKey mozi_key_123' })).toBe('mozi_key_123');
    expect(extractApiCredential({ 'x-api-key': 'direct_key' })).toBe('direct_key');
    expect(extractApiCredential({})).toBeNull();
  });

  it('prefers httpOnly cookie over Authorization header', () => {
    const cookies = { [AUTH_COOKIE_NAME]: 'cookie.jwt.token' };
    expect(extractApiCredential({ authorization: 'Bearer header.jwt.token' }, cookies)).toBe('cookie.jwt.token');
    expect(extractApiCredential({}, cookies)).toBe('cookie.jwt.token');
    expect(extractApiCredential({ authorization: 'Bearer fallback.token' }, {})).toBe('fallback.token');
    expect(extractApiCredential({}, {})).toBeNull();
  });

  it('marks health, pairing, and logout routes as public', () => {
    expect(isPublicApiRoute('GET', '/api/health')).toBe(true);
    expect(isPublicApiRoute('GET', '/api/version')).toBe(true);
    expect(isPublicApiRoute('GET', '/api/office/file')).toBe(true);
    expect(isPublicApiRoute('GET', '/api/office/session')).toBe(false);
    expect(isPublicApiRoute('GET', '/api/auth/status')).toBe(true);
    expect(isPublicApiRoute('POST', '/api/auth/pair')).toBe(true);
    expect(isPublicApiRoute('POST', '/api/auth/logout')).toBe(true);
    expect(isPublicApiRoute('POST', '/api/auth/register')).toBe(false);
    expect(isPublicApiRoute('POST', '/api/auth/login')).toBe(false);
    expect(isPublicApiRoute('POST', '/api/auth/register', 'local')).toBe(true);
    expect(isPublicApiRoute('POST', '/api/auth/login', 'local')).toBe(true);
    expect(isPublicApiRoute('GET', '/api/sessions')).toBe(false);
  });

  it('assigns required role by route sensitivity and method', () => {
    expect(requiredRoleForApiRoute('GET', '/api/sessions')).toBe('viewer');
    expect(requiredRoleForApiRoute('POST', '/api/sessions')).toBe('operator');
    expect(requiredRoleForApiRoute('PATCH', '/api/sessions/:id')).toBe('operator');
    expect(requiredRoleForApiRoute('GET', '/api/runtime/service')).toBe('viewer');
    expect(requiredRoleForApiRoute('GET', '/api/runtime/desktop-capabilities')).toBe('viewer');
    expect(requiredRoleForApiRoute('POST', '/api/runtime/service')).toBe('admin');
    expect(requiredRoleForApiRoute('GET', '/api/config')).toBe('admin');
    expect(requiredRoleForApiRoute('POST', '/api/config')).toBe('admin');
    expect(requiredRoleForApiRoute('POST', '/api/users')).toBe('admin');
    expect(requiredRoleForApiRoute('PATCH', '/api/users/user-1')).toBe('admin');
    expect(requiredRoleForApiRoute('POST', '/api/auth/invites')).toBe('admin');
    expect(requiredRoleForApiRoute('POST', '/api/auth/password')).toBe('viewer');
    expect(requiredRoleForApiRoute('GET', '/api/task-templates')).toBe('viewer');
    expect(requiredRoleForApiRoute('POST', '/api/task-templates')).toBe('viewer');
    expect(requiredRoleForApiRoute('PUT', '/api/task-templates/reorder')).toBe('viewer');
    expect(requiredRoleForApiRoute('DELETE', '/api/task-templates/template-1')).toBe('viewer');
  });

  it('reserves tenant infrastructure config writes for admins', () => {
    expect(requiredRoleForApiRoute('POST', '/api/keys/openai')).toBe('admin');
    expect(requiredRoleForApiRoute('DELETE', '/api/keys/openai')).toBe('admin');
    expect(requiredRoleForApiRoute('GET', '/api/keys')).toBe('viewer');
    expect(requiredRoleForApiRoute('POST', '/api/search-key')).toBe('admin');
    expect(requiredRoleForApiRoute('GET', '/api/search-key')).toBe('viewer');
    expect(requiredRoleForApiRoute('POST', '/api/services/tavily/key')).toBe('admin');
    expect(requiredRoleForApiRoute('DELETE', '/api/services/tavily/key')).toBe('admin');
    expect(requiredRoleForApiRoute('POST', '/api/services/search/active')).toBe('admin');
    expect(requiredRoleForApiRoute('GET', '/api/services')).toBe('viewer');
    expect(requiredRoleForApiRoute('PATCH', '/api/models/roles')).toBe('admin');
    expect(requiredRoleForApiRoute('GET', '/api/models/roles')).toBe('viewer');
    expect(requiredRoleForApiRoute('GET', '/api/coding-workers')).toBe('viewer');
    expect(requiredRoleForApiRoute('PUT', '/api/coding-workers')).toBe('admin');
    expect(requiredRoleForApiRoute('POST', '/api/brain')).toBe('admin');
    expect(requiredRoleForApiRoute('POST', '/api/providers/openai/check')).toBe('admin');
    expect(requiredRoleForApiRoute('POST', '/api/providers/openai/models/manual')).toBe('admin');
  });

  it('checks role hierarchy correctly', () => {
    expect(hasApiRole('viewer', 'viewer')).toBe(true);
    expect(hasApiRole('viewer', 'operator')).toBe(true);
    expect(hasApiRole('operator', 'viewer')).toBe(false);
    expect(hasApiRole('admin', 'operator')).toBe(false);
    expect(hasApiRole('admin', 'admin')).toBe(true);
  });
});
