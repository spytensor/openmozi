/**
 * Legacy Environment Variable Migration.
 *
 * Migrates legacy env vars where OPENAI_API_KEY + OPENAI_BASE_URL was used
 * for non-OpenAI providers (e.g. minimax, moonshot).
 *
 * Also fixes config file if brain_provider doesn't match known model families.
 *
 * This module is only called once at startup.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { getEnvPath, getConfigPath } from '../paths.js';
import pino from 'pino';
import { readConfigWithLegacyFallback, writeConfigObject } from '../config/storage.js';
import { escapeRegex } from './provider-catalog.js';

const logger = pino({ name: 'mozi:providers' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MigrationResult {
  migrated: string[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Migrate legacy env vars where OPENAI_API_KEY + OPENAI_BASE_URL was used
 * for non-OpenAI providers (e.g. minimax, moonshot).
 *
 * Also fixes config file if brain_provider doesn't match known model families.
 */
export function migrateEnvVars(): MigrationResult {
  const migrated: string[] = [];
  const warnings: string[] = [];

  const baseUrl = process.env.OPENAI_BASE_URL || '';
  const openaiKey = process.env.OPENAI_API_KEY || '';

  const isMiniMaxLegacyBase =
    baseUrl.includes('minimax.chat') ||
    baseUrl.includes('minimax.io') ||
    baseUrl.includes('minimaxi.com');

  const isMoonshotLegacyBase =
    baseUrl.includes('moonshot.cn') ||
    baseUrl.includes('moonshot.ai');

  // Migrate MiniMax: OPENAI_BASE_URL points to MiniMax
  if (isMiniMaxLegacyBase && openaiKey && !process.env.MINIMAX_API_KEY) {
    process.env.MINIMAX_API_KEY = openaiKey;
    migrated.push('OPENAI_API_KEY -> MINIMAX_API_KEY (detected MiniMax base URL)');
    updateEnvFile('MINIMAX_API_KEY', openaiKey);
    removeEnvLine('OPENAI_BASE_URL');

    // Only remove OPENAI_API_KEY when it clearly does not look like an OpenAI key.
    if (!isRealOpenAIKey(openaiKey)) {
      removeEnvLine('OPENAI_API_KEY');
      delete process.env.OPENAI_API_KEY;
    }
    delete process.env.OPENAI_BASE_URL;
  }

  // Migrate Moonshot: OPENAI_BASE_URL points to Moonshot
  if (isMoonshotLegacyBase && openaiKey && !process.env.MOONSHOT_API_KEY) {
    process.env.MOONSHOT_API_KEY = openaiKey;
    migrated.push('OPENAI_API_KEY -> MOONSHOT_API_KEY (detected Moonshot base URL)');
    updateEnvFile('MOONSHOT_API_KEY', openaiKey);
    removeEnvLine('OPENAI_BASE_URL');

    if (!isRealOpenAIKey(openaiKey)) {
      removeEnvLine('OPENAI_API_KEY');
      delete process.env.OPENAI_API_KEY;
    }
    delete process.env.OPENAI_BASE_URL;
  }

  migrateConfigFile(migrated, warnings);

  if (migrated.length > 0) {
    logger.info({ migrated }, 'Legacy env vars migrated');
  }

  return { migrated, warnings };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Check if a key looks like a real OpenAI key (starts with sk- but not Anthropic). */
function isRealOpenAIKey(key: string): boolean {
  return key.startsWith('sk-') && !key.startsWith('sk-ant-');
}

/** Set or update a key in the .env file. */
function updateEnvFile(key: string, value: string): void {
  try {
    const envPath = getEnvPath();
    let content = '';
    if (existsSync(envPath)) {
      content = readFileSync(envPath, 'utf-8');
      const regex = new RegExp(`^${escapeRegex(key)}=.*$`, 'm');
      if (regex.test(content)) {
        content = content.replace(regex, `${key}=${value}`);
        writeFileSync(envPath, content, { mode: 0o600 });
        return;
      }
    }
    const nl = content && !content.endsWith('\n') ? '\n' : '';
    writeFileSync(envPath, `${content}${nl}${key}=${value}\n`, { mode: 0o600 });
  } catch (err) {
    logger.warn({ key, error: err instanceof Error ? err.message : String(err) }, 'Failed to update .env file');
  }
}

/** Remove a key line from the .env file. */
function removeEnvLine(key: string): void {
  try {
    const envPath = getEnvPath();
    if (!existsSync(envPath)) return;

    let content = readFileSync(envPath, 'utf-8');
    const regex = new RegExp(`^${escapeRegex(key)}=.*\\n?`, 'gm');
    content = content.replace(regex, '');
    writeFileSync(envPath, content, { mode: 0o600 });
  } catch (err) {
    logger.warn({ key, error: err instanceof Error ? err.message : String(err) }, 'Failed to remove env line');
  }
}

/** Known MiniMax/Moonshot model families for config migration. */
const MINIMAX_MODELS = ['MiniMax-M2.5', 'MiniMax-M2.1', 'MiniMax-M1'];
const MOONSHOT_MODELS = [
  'moonshot-v1-8k',
  'moonshot-v1-32k',
  'moonshot-v1-128k',
  'kimi-k2.5',
  'kimi-k2-thinking',
];

/**
 * Migrate config where provider is still `openai` but model clearly belongs
 * to another known provider.
 */
function migrateConfigFile(migrated: string[], warnings: string[]): void {
  try {
    const configPath = getConfigPath();
    const { config, sourcePath } = readConfigWithLegacyFallback(configPath);
    if (!sourcePath) return;

    let changed = false;
    const brain = config.brain as Record<string, unknown> | undefined;
    const router = config.model_router as Record<string, unknown> | undefined;
    const brainModel = brain?.model as string | undefined;
    const brainProvider = router?.brain_provider as string | undefined;

    if (brainProvider === 'openai' && brainModel && MINIMAX_MODELS.includes(brainModel)) {
      if (!router) {
        config.model_router = { brain_provider: 'minimax' };
      } else {
        router.brain_provider = 'minimax';
      }
      changed = true;
      migrated.push(`mozi.json: brain_provider 'openai' -> 'minimax' (model: ${brainModel})`);
    }

    if (brainProvider === 'openai' && brainModel && MOONSHOT_MODELS.includes(brainModel)) {
      if (!router) {
        config.model_router = { brain_provider: 'moonshot' };
      } else {
        router.brain_provider = 'moonshot';
      }
      changed = true;
      migrated.push(`mozi.json: brain_provider 'openai' -> 'moonshot' (model: ${brainModel})`);
    }

    if (router?.roles && typeof router.roles === 'object') {
      const roles = router.roles as Record<string, Record<string, string>>;
      for (const [roleName, role] of Object.entries(roles)) {
        if (role.provider === 'openai' && MINIMAX_MODELS.includes(role.model)) {
          role.provider = 'minimax';
          changed = true;
          migrated.push(`mozi.json: roles.${roleName}.provider 'openai' -> 'minimax'`);
        }
        if (role.provider === 'openai' && MOONSHOT_MODELS.includes(role.model)) {
          role.provider = 'moonshot';
          changed = true;
          migrated.push(`mozi.json: roles.${roleName}.provider 'openai' -> 'moonshot'`);
        }
      }
    }

    if (changed) {
      writeConfigObject(configPath, config);
    }
  } catch (err) {
    warnings.push(`config migration failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
