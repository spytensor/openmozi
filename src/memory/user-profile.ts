import pino from 'pino';
import { saveFact, getFacts, type MemoryFact } from './long-term.js';
import type { LLMClient, ChatMessage } from '../core/llm.js';

const logger = pino({ name: 'mozi:memory:user-profile' });

/** Global scope for profile facts — not bound to any chat/session */
const PROFILE_CHAT_ID = '__profile__';

/** Required profile fields that must be collected during first contact */
const REQUIRED_FIELDS = [
  'user_display_name',
  'communication_style',
  'language_preference',
  'primary_use_case',
  'primary_domain',
] as const;

/** Optional profile fields that can be inferred over time */
const OPTIONAL_FIELDS = [
  'bot_nickname',
  'tech_level',
] as const;

type RequiredField = (typeof REQUIRED_FIELDS)[number];
type OptionalField = (typeof OPTIONAL_FIELDS)[number];
type ProfileField = RequiredField | OptionalField;

/** User profile data */
export interface UserProfile {
  user_display_name: string | null;
  communication_style: string | null;
  language_preference: string | null;
  primary_use_case: string | null;
  primary_domain: string | null;
  bot_nickname: string | null;
  tech_level: string | null;
}

/** Result of profile extraction from conversation */
export interface ProfileExtractionResult {
  extracted: Partial<Record<ProfileField, string>>;
  newlyCompleted: boolean;
}

// In-memory cache to avoid querying DB on every message
const completionCache = new Map<string, boolean>();

/**
 * Read the user profile from memory_facts where chat_id = '__profile__'.
 */
export function getProfile(tenantId = 'default'): UserProfile {
  const facts = getFacts(PROFILE_CHAT_ID, 'preference', tenantId);
  const profile: UserProfile = {
    user_display_name: null,
    communication_style: null,
    language_preference: null,
    primary_use_case: null,
    primary_domain: null,
    bot_nickname: null,
    tech_level: null,
  };

  for (const fact of facts) {
    if (fact.key in profile) {
      (profile as unknown as Record<string, string | null>)[fact.key] = fact.value;
    }
  }

  return profile;
}

/**
 * Check whether all required profile fields have been collected.
 * Uses in-memory cache to avoid DB queries on every message.
 */
export function isProfileComplete(tenantId = 'default'): boolean {
  const cached = completionCache.get(tenantId);
  if (cached !== undefined) return cached;

  const profile = getProfile(tenantId);
  const complete = REQUIRED_FIELDS.every(
    field => profile[field] !== null && profile[field]!.trim().length > 0,
  );
  completionCache.set(tenantId, complete);
  return complete;
}

/**
 * Save a single profile field to long-term memory.
 */
export function saveProfileField(
  key: ProfileField,
  value: string,
  tenantId = 'default',
): void {
  saveFact(PROFILE_CHAT_ID, 'preference', key, value, 'profile_extraction', tenantId);
  // Invalidate cache — completion status may have changed
  completionCache.delete(tenantId);
}

/**
 * Clear the completion cache for a tenant.
 * Useful for testing or when profile is externally modified.
 */
export function invalidateProfileCache(tenantId?: string): void {
  if (tenantId) {
    completionCache.delete(tenantId);
  } else {
    completionCache.clear();
  }
}

/**
 * Build the first-contact guide text to inject into the system prompt.
 * Lists missing required fields and any already-collected ones.
 */
export function getFirstContactGuide(tenantId = 'default'): string {
  const profile = getProfile(tenantId);
  const allFields: ProfileField[] = [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS];
  const missing: string[] = [];
  const collected: string[] = [];

  for (const field of allFields) {
    const val = profile[field];
    if (val && val.trim().length > 0) {
      collected.push(`- ${fieldLabel(field)}: ${val}`);
    } else {
      const required = (REQUIRED_FIELDS as readonly string[]).includes(field);
      missing.push(`- ${fieldLabel(field)}${required ? ' (required)' : ' (optional)'}: ${fieldHint(field)}`);
    }
  }

  const parts: string[] = [
    '## First Contact — Getting to Know the User',
    '',
    'This is a new user. Your goal in the first 2-3 turns is to understand WHO they are',
    'and HOW they want to work with you. This understanding shapes all future interactions.',
    '',
    'Do NOT present as a form or checklist. Have a natural, warm conversation.',
  ];

  if (missing.length > 0) {
    parts.push('', '### Information still needed:', ...missing);
  }

  if (collected.length > 0) {
    parts.push('', '### Already known:', ...collected);
  }

  parts.push(
    '',
    '### Conversation strategy:',
    '',
    '**Turn 1 (greeting):**',
    '- Introduce yourself briefly — you are MOZI, an autonomous agent OS.',
    '- Ask their name and what kind of work they mainly do.',
    '- Example: "I\'m MOZI. Before we start, I\'d like to know a bit about you —',
    '  what should I call you, and what kind of work will we be tackling together?"',
    '',
    '**Turn 2 (understand their world):**',
    '- Based on their answer, ask a follow-up about their typical workflow or main challenges.',
    '- Infer their tech_level from vocabulary and context (don\'t ask directly).',
    '- Infer communication_style from how they write (concise vs detailed, casual vs formal).',
    '- If they mention a domain, confirm it. If not, ask what field they work in.',
    '',
    '**Turn 3+ (start working):**',
    '- By now you should have enough context. Start being useful.',
    '- Fill in any remaining gaps naturally as the conversation flows.',
    '- Default bot_nickname to "MOZI" if not specified by turn 3.',
    '',
    '### Critical rules:',
    '- If the user jumps straight into a task, help them FIRST, then circle back to profiling.',
    '- Never refuse help because the profile is incomplete.',
    '- Use the language of the user\'s current message unless they explicitly request a different response language.',
    '- The user\'s primary_use_case matters most — it determines how you frame all future help.',
  );

  return parts.join('\n');
}

/**
 * Build the profile section for context-builder injection.
 * Always injected (bypasses relevance filter) so Brain knows who the user is.
 * Returns empty string if no profile data exists.
 */
export function getProfileSection(tenantId = 'default'): string {
  const profile = getProfile(tenantId);
  const lines: string[] = [];

  if (profile.user_display_name) {
    lines.push(`- Name: ${profile.user_display_name}`);
  }
  if (profile.language_preference) {
    lines.push(`- Language: ${profile.language_preference}`);
  }
  if (profile.communication_style) {
    lines.push(`- Communication Style: ${profile.communication_style}`);
  }
  if (profile.primary_use_case) {
    lines.push(`- Primary Use Case: ${profile.primary_use_case}`);
  }
  if (profile.primary_domain) {
    lines.push(`- Domain: ${profile.primary_domain}`);
  }
  if (profile.tech_level) {
    lines.push(`- Technical Level: ${profile.tech_level}`);
  }
  if (profile.bot_nickname) {
    lines.push(`- Bot Nickname: ${profile.bot_nickname}`);
  }

  if (lines.length === 0) return '';

  return `## User Profile\n${lines.join('\n')}`;
}

const EXTRACTION_PROMPT = `Extract user profile information from this conversation turn.
Fields to extract:
- user_display_name: How the user wants to be addressed
- communication_style: One of "concise", "detailed", "casual", "formal" — infer from writing patterns, sentence length, emoji usage, and tone
- language_preference: Preferred response language only if the user explicitly requests it (e.g. "en", "zh", "ja", "ko")
- primary_use_case: What the user mainly wants to use this assistant for (e.g. "coding", "writing", "research", "project management", "learning", "creative work")
- primary_domain: The user's field or industry (e.g. "web development", "data science", "finance", "education", "design")
- bot_nickname: What the user wants to call this assistant (only if explicitly mentioned)
- tech_level: One of "beginner", "intermediate", "advanced", "expert" — infer from vocabulary, concepts mentioned, and how they describe problems

Output JSON only. Use null for fields not mentioned or not inferable.
Example: {"user_display_name":"Alice","communication_style":"casual","language_preference":"en","primary_use_case":"coding","primary_domain":"web development","bot_nickname":null,"tech_level":"advanced"}`;

/**
 * Use LLM to extract profile fields from a conversation turn.
 * Runs as a focused extraction — cheap and fast.
 */
export async function extractProfileFromConversation(
  userMessage: string,
  assistantResponse: string,
  client: LLMClient,
  tenantId = 'default',
): Promise<ProfileExtractionResult> {
  const result: ProfileExtractionResult = { extracted: {}, newlyCompleted: false };

  if (!client || typeof client.chat !== 'function') {
    return result;
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: EXTRACTION_PROMPT },
    {
      role: 'user',
      content: `User message:\n${userMessage}\n\nAssistant response:\n${assistantResponse}`,
    },
  ];

  let response;
  try {
    response = await client.chat(messages, { max_tokens: 200, temperature: 0 });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: errMsg }, 'Profile extraction LLM call failed');
    return result;
  }

  const content = response.content.trim();
  const jsonStart = content.indexOf('{');
  const jsonEnd = content.lastIndexOf('}');
  if (jsonStart < 0 || jsonEnd <= jsonStart) {
    logger.debug('Profile extraction returned non-JSON');
    return result;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content.slice(jsonStart, jsonEnd + 1));
  } catch {
    logger.debug('Profile extraction JSON parse failed');
    return result;
  }

  const allFields: ProfileField[] = [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS];
  const wasPreviouslyComplete = isProfileComplete(tenantId);

  for (const field of allFields) {
    const value = parsed[field];
    if (typeof value === 'string' && value.trim().length > 0) {
      saveProfileField(field, value.trim(), tenantId);
      result.extracted[field] = value.trim();
    }
  }

  if (!wasPreviouslyComplete && isProfileComplete(tenantId)) {
    result.newlyCompleted = true;
    logger.info({ tenantId }, 'User profile completed via first-contact extraction');
  }

  return result;
}

// ---------------------------------------------------------------------------
// Per-User Routing Preferences
// ---------------------------------------------------------------------------

/** Prefix for per-user routing preference facts */
const ROUTING_PREFS_CHAT_ID_PREFIX = '__routing_prefs__';

function buildRoutingPrefsChatId(userId: string): string {
  return `${ROUTING_PREFS_CHAT_ID_PREFIX}:${userId}`;
}

/** Allowed routing preference keys */
export type RoutingPrefKey =
  | 'cost_sensitivity'
  | 'preferred_code_provider'
  | 'preferred_code_model'
  | 'preferred_vision_provider'
  | 'preferred_vision_model'
  | 'preferred_cheap_provider'
  | 'preferred_cheap_model'
  | 'preferred_summary_provider'
  | 'preferred_summary_model';

/** Structured per-user routing preferences (mirrors global RoutingPreferences). */
export interface UserRoutingPreferences {
  cost_sensitivity?: 'low' | 'medium' | 'high';
  preferred_code?: { provider?: string; model?: string };
  preferred_vision?: { provider?: string; model?: string };
  preferred_cheap?: { provider?: string; model?: string };
  preferred_summary?: { provider?: string; model?: string };
}

/**
 * Save a per-user/tenant routing preference to long-term memory.
 */
export function saveUserRoutingPreference(
  key: RoutingPrefKey,
  value: string,
  userId: string,
  tenantId = 'default',
): void {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) return;
  saveFact(
    buildRoutingPrefsChatId(normalizedUserId),
    'preference',
    key,
    value,
    'user_routing_pref',
    tenantId,
    normalizedUserId,
  );
}

/**
 * Read per-user/tenant routing preferences from long-term memory.
 * Returns a structured object matching the global RoutingPreferences shape.
 */
export function getUserRoutingPreferences(
  userId: string,
  tenantId = 'default',
): UserRoutingPreferences {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) return {};
  const facts = getFacts(buildRoutingPrefsChatId(normalizedUserId), 'preference', tenantId);
  const map = new Map<string, string>();
  for (const f of facts) {
    map.set(f.key, f.value);
  }

  const prefs: UserRoutingPreferences = {};

  const cs = map.get('cost_sensitivity');
  if (cs === 'low' || cs === 'medium' || cs === 'high') {
    prefs.cost_sensitivity = cs;
  }

  const codeProv = map.get('preferred_code_provider');
  const codeModel = map.get('preferred_code_model');
  if (codeProv || codeModel) {
    prefs.preferred_code = { provider: codeProv, model: codeModel };
  }

  const visProv = map.get('preferred_vision_provider');
  const visModel = map.get('preferred_vision_model');
  if (visProv || visModel) {
    prefs.preferred_vision = { provider: visProv, model: visModel };
  }

  const cheapProv = map.get('preferred_cheap_provider');
  const cheapModel = map.get('preferred_cheap_model');
  if (cheapProv || cheapModel) {
    prefs.preferred_cheap = { provider: cheapProv, model: cheapModel };
  }

  const sumProv = map.get('preferred_summary_provider');
  const sumModel = map.get('preferred_summary_model');
  if (sumProv || sumModel) {
    prefs.preferred_summary = { provider: sumProv, model: sumModel };
  }

  return prefs;
}

/**
 * Merge per-user routing preferences on top of global routing preferences.
 * Per-user values override global values where set. Fields not set at user
 * level fall through to the global value.
 *
 * Precedence: per-user > global config
 */
export function mergeRoutingPreferences(
  global: UserRoutingPreferences | undefined,
  perUser: UserRoutingPreferences,
): UserRoutingPreferences {
  const merged: UserRoutingPreferences = { ...global };

  if (perUser.cost_sensitivity) merged.cost_sensitivity = perUser.cost_sensitivity;
  if (perUser.preferred_code) merged.preferred_code = { ...merged.preferred_code, ...perUser.preferred_code };
  if (perUser.preferred_vision) merged.preferred_vision = { ...merged.preferred_vision, ...perUser.preferred_vision };
  if (perUser.preferred_cheap) merged.preferred_cheap = { ...merged.preferred_cheap, ...perUser.preferred_cheap };
  if (perUser.preferred_summary) merged.preferred_summary = { ...merged.preferred_summary, ...perUser.preferred_summary };

  return merged;
}

// ── Helpers ──

function fieldLabel(field: ProfileField): string {
  const labels: Record<ProfileField, string> = {
    user_display_name: 'Name',
    communication_style: 'Communication Style',
    language_preference: 'Language',
    primary_use_case: 'Primary Use Case',
    primary_domain: 'Domain / Field',
    bot_nickname: 'Bot Nickname',
    tech_level: 'Technical Level',
  };
  return labels[field];
}

function fieldHint(field: ProfileField): string {
  const hints: Record<ProfileField, string> = {
    user_display_name: 'How the user wants to be addressed',
    communication_style: 'Infer from their writing: concise / detailed / casual / formal',
    language_preference: 'Only set if the user explicitly requests a preferred response language',
    primary_use_case: 'What they mainly want to do: coding, research, writing, etc.',
    primary_domain: 'Their field: web dev, data science, finance, education, etc.',
    bot_nickname: 'What they call this assistant (default: MOZI)',
    tech_level: 'Infer from vocabulary: beginner / intermediate / advanced / expert',
  };
  return hints[field];
}
