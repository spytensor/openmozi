import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import {
  getProfile,
  isProfileComplete,
  saveProfileField,
  getFirstContactGuide,
  getProfileSection,
  extractProfileFromConversation,
  invalidateProfileCache,
  saveUserRoutingPreference,
  getUserRoutingPreferences,
  mergeRoutingPreferences,
} from './user-profile.js';
import { getFacts } from './long-term.js';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import type { LLMClient, ChatResponse, ChatMessage, ChatOptions, StreamChunk } from '../core/llm.js';

let tmpDir: string;

beforeAll(() => {
  const result = setupTestDb();
  tmpDir = result.tmpDir;
});

afterAll(() => {
  teardownTestDb(tmpDir);
});

beforeEach(() => {
  invalidateProfileCache();
});

function makeMockClient(content: string): LLMClient {
  return {
    provider: 'mock',
    chat: vi.fn().mockResolvedValue({
      content,
      usage: { input_tokens: 10, output_tokens: 20 },
      model: 'mock-model',
      stop_reason: 'end',
    } satisfies ChatResponse),
    async *chatStream(_msgs: ChatMessage[], _opts?: ChatOptions): AsyncGenerator<StreamChunk> {
      yield {
        type: 'done',
        response: {
          content,
          usage: { input_tokens: 10, output_tokens: 20 },
          model: 'mock-model',
          stop_reason: 'end',
        },
      };
    },
  };
}

describe('memory/user-profile', () => {
  it('returns empty profile for new tenant', () => {
    const profile = getProfile('new_tenant_empty');
    expect(profile.user_display_name).toBeNull();
    expect(profile.communication_style).toBeNull();
    expect(profile.language_preference).toBeNull();
    expect(profile.primary_use_case).toBeNull();
    expect(profile.primary_domain).toBeNull();
    expect(profile.bot_nickname).toBeNull();
    expect(profile.tech_level).toBeNull();
  });

  it('saves and retrieves profile fields', () => {
    const tid = 'profile_save_test';
    saveProfileField('user_display_name', 'Alice', tid);
    saveProfileField('bot_nickname', 'Mozy', tid);
    const profile = getProfile(tid);
    expect(profile.user_display_name).toBe('Alice');
    expect(profile.bot_nickname).toBe('Mozy');
  });

  it('stores facts under __profile__ chat_id', () => {
    const tid = 'profile_chatid_test';
    saveProfileField('user_display_name', 'Bob', tid);
    const facts = getFacts('__profile__', 'preference', tid);
    const nameFact = facts.find(f => f.key === 'user_display_name');
    expect(nameFact).toBeDefined();
    expect(nameFact!.value).toBe('Bob');
    expect(nameFact!.source).toBe('profile_extraction');
  });

  it('upserts on duplicate key', () => {
    const tid = 'profile_upsert_test';
    saveProfileField('bot_nickname', 'OldName', tid);
    saveProfileField('bot_nickname', 'NewName', tid);
    const profile = getProfile(tid);
    expect(profile.bot_nickname).toBe('NewName');
    // Should have exactly one fact for this key
    const facts = getFacts('__profile__', 'preference', tid);
    const nickFacts = facts.filter(f => f.key === 'bot_nickname');
    expect(nickFacts).toHaveLength(1);
  });

  it('isProfileComplete false when required fields missing', () => {
    const tid = 'profile_incomplete_test';
    saveProfileField('user_display_name', 'Alice', tid);
    // Missing communication_style, language_preference, primary_use_case, primary_domain
    expect(isProfileComplete(tid)).toBe(false);
  });

  it('isProfileComplete true when all required set', () => {
    const tid = 'profile_complete_test';
    saveProfileField('user_display_name', 'Alice', tid);
    saveProfileField('communication_style', 'casual', tid);
    saveProfileField('language_preference', 'en', tid);
    saveProfileField('primary_use_case', 'coding', tid);
    saveProfileField('primary_domain', 'web development', tid);
    expect(isProfileComplete(tid)).toBe(true);
  });

  it('getFirstContactGuide lists missing fields', () => {
    const tid = 'profile_guide_test';
    saveProfileField('user_display_name', 'Alice', tid);
    const guide = getFirstContactGuide(tid);

    // Should list missing required fields
    expect(guide).toContain('Communication Style');
    expect(guide).toContain('Primary Use Case');
    expect(guide).toContain('Domain');
    // Should show already collected
    expect(guide).toContain('Alice');
    expect(guide).toContain('Already known');
    // Should contain conversation strategy
    expect(guide).toContain('Conversation strategy');
  });

  it('getProfileSection empty for new tenant', () => {
    const section = getProfileSection('brand_new_tenant');
    expect(section).toBe('');
  });

  it('getProfileSection returns formatted section', () => {
    const tid = 'profile_section_test';
    saveProfileField('user_display_name', 'Alex', tid);
    saveProfileField('communication_style', 'formal', tid);
    const section = getProfileSection(tid);
    expect(section).toContain('## User Profile');
    expect(section).toContain('Alex');
    expect(section).toContain('formal');
  });

  it('extractProfileFromConversation parses LLM JSON response', async () => {
    const tid = 'profile_extract_test';
    const client = makeMockClient(JSON.stringify({
      user_display_name: 'Diana',
      communication_style: 'casual',
      language_preference: 'en',
      primary_use_case: 'coding',
      primary_domain: 'web development',
      bot_nickname: null,
      tech_level: 'advanced',
    }));

    const result = await extractProfileFromConversation(
      'Hi! I\'m Diana, I\'m a web developer.',
      'Hello Diana! How can I help you today?',
      client,
      tid,
    );

    expect(result.extracted.user_display_name).toBe('Diana');
    expect(result.extracted.communication_style).toBe('casual');
    expect(result.extracted.language_preference).toBe('en');
    expect(result.extracted.primary_use_case).toBe('coding');
    expect(result.extracted.primary_domain).toBe('web development');
    expect(result.extracted.tech_level).toBe('advanced');
    // null values should not be extracted
    expect(result.extracted.bot_nickname).toBeUndefined();

    // Should be persisted in DB
    const profile = getProfile(tid);
    expect(profile.user_display_name).toBe('Diana');
    expect(profile.communication_style).toBe('casual');
    expect(profile.primary_use_case).toBe('coding');
  });

  it('isolates profiles by tenantId', () => {
    saveProfileField('user_display_name', 'TenantA_User', 'tenant_a_profile');
    saveProfileField('user_display_name', 'TenantB_User', 'tenant_b_profile');

    const profileA = getProfile('tenant_a_profile');
    const profileB = getProfile('tenant_b_profile');
    expect(profileA.user_display_name).toBe('TenantA_User');
    expect(profileB.user_display_name).toBe('TenantB_User');
  });

  describe('per-user routing preferences', () => {
    it('returns empty preferences for new user', () => {
      const prefs = getUserRoutingPreferences('new-user', 'routing_new_tenant');
      expect(prefs).toEqual({});
    });

    it('saves and retrieves routing preferences', () => {
      const tid = 'routing_save_test';
      const userId = 'routing_user';
      saveUserRoutingPreference('cost_sensitivity', 'high', userId, tid);
      saveUserRoutingPreference('preferred_code_provider', 'anthropic', userId, tid);
      saveUserRoutingPreference('preferred_code_model', 'claude-sonnet-4', userId, tid);

      const prefs = getUserRoutingPreferences(userId, tid);
      expect(prefs.cost_sensitivity).toBe('high');
      expect(prefs.preferred_code).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' });
    });

    it('isolates routing preferences by user within the same tenant', () => {
      saveUserRoutingPreference('cost_sensitivity', 'low', 'user-a', 'routing_shared_tenant');
      saveUserRoutingPreference('cost_sensitivity', 'high', 'user-b', 'routing_shared_tenant');

      const prefsA = getUserRoutingPreferences('user-a', 'routing_shared_tenant');
      const prefsB = getUserRoutingPreferences('user-b', 'routing_shared_tenant');
      expect(prefsA.cost_sensitivity).toBe('low');
      expect(prefsB.cost_sensitivity).toBe('high');
    });

    it('isolates routing preferences by tenant', () => {
      saveUserRoutingPreference('cost_sensitivity', 'low', 'shared-user', 'routing_tenant_a');
      saveUserRoutingPreference('cost_sensitivity', 'high', 'shared-user', 'routing_tenant_b');

      const prefsA = getUserRoutingPreferences('shared-user', 'routing_tenant_a');
      const prefsB = getUserRoutingPreferences('shared-user', 'routing_tenant_b');
      expect(prefsA.cost_sensitivity).toBe('low');
      expect(prefsB.cost_sensitivity).toBe('high');
    });

    it('handles partial preference (only provider, no model)', () => {
      const tid = 'routing_partial_test';
      saveUserRoutingPreference('preferred_vision_provider', 'google', 'partial-user', tid);

      const prefs = getUserRoutingPreferences('partial-user', tid);
      expect(prefs.preferred_vision).toEqual({ provider: 'google' });
    });

    it('ignores invalid cost_sensitivity values', () => {
      const tid = 'routing_invalid_cs';
      saveUserRoutingPreference('cost_sensitivity', 'extreme', 'invalid-user', tid);

      const prefs = getUserRoutingPreferences('invalid-user', tid);
      expect(prefs.cost_sensitivity).toBeUndefined();
    });
  });

  describe('mergeRoutingPreferences', () => {
    it('per-user overrides global where set', () => {
      const global = {
        cost_sensitivity: 'medium' as const,
        preferred_code: { provider: 'openai', model: 'gpt-4.1' },
        preferred_vision: { provider: 'google', model: 'gemini-2.5-flash' },
      };
      const perUser = {
        cost_sensitivity: 'high' as const,
        preferred_code: { provider: 'anthropic', model: 'claude-sonnet-4' },
      };

      const merged = mergeRoutingPreferences(global, perUser);
      expect(merged.cost_sensitivity).toBe('high');
      expect(merged.preferred_code).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' });
      // Vision not overridden — keeps global
      expect(merged.preferred_vision).toEqual({ provider: 'google', model: 'gemini-2.5-flash' });
    });

    it('per-user partial override merges with global', () => {
      const global = {
        preferred_cheap: { provider: 'openai', model: 'gpt-4.1-mini' },
      };
      const perUser = {
        preferred_cheap: { provider: 'deepseek' },
      };

      const merged = mergeRoutingPreferences(global, perUser);
      // Provider overridden, model inherited from global
      expect(merged.preferred_cheap).toEqual({ provider: 'deepseek', model: 'gpt-4.1-mini' });
    });

    it('works when global is undefined', () => {
      const perUser = {
        cost_sensitivity: 'low' as const,
        preferred_code: { provider: 'anthropic', model: 'claude-sonnet-4' },
      };

      const merged = mergeRoutingPreferences(undefined, perUser);
      expect(merged.cost_sensitivity).toBe('low');
      expect(merged.preferred_code).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' });
    });

    it('returns global when per-user is empty', () => {
      const global = {
        cost_sensitivity: 'medium' as const,
        preferred_code: { provider: 'openai', model: 'gpt-4.1' },
      };

      const merged = mergeRoutingPreferences(global, {});
      expect(merged).toEqual(global);
    });
  });
});
