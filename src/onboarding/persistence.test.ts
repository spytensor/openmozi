import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getConfigPath, getEnvPath } from '../paths.js';
import { parseConfigContent } from '../config/storage.js';
import { generateMasterKey, getSecret } from '../security/secrets.js';
import {
  persistSearchKey,
  persistTelegramBotToken,
  persistEnvValue,
  readPersistedSecret,
  readEnvVar,
  saveServerDefaultsToConfig,
  saveWizardRuntimeConfig,
  saveWorkspaceDirToConfig,
  upsertEnvVar,
  validateOnboardingWriteContract,
} from './persistence.js';

let tmpHome = '';
let moziHomeBackup: string | undefined;
let searchKeyBackup: string | undefined;
let telegramKeyBackup: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'mozi-onboarding-persistence-'));
  moziHomeBackup = process.env.MOZI_HOME;
  searchKeyBackup = process.env.SEARCH1API_KEY;
  telegramKeyBackup = process.env.TELEGRAM_BOT_TOKEN;
  process.env.MOZI_HOME = tmpHome;
  delete process.env.SEARCH1API_KEY;
  delete process.env.TELEGRAM_BOT_TOKEN;
});

afterEach(() => {
  if (moziHomeBackup === undefined) delete process.env.MOZI_HOME;
  else process.env.MOZI_HOME = moziHomeBackup;
  if (searchKeyBackup === undefined) delete process.env.SEARCH1API_KEY;
  else process.env.SEARCH1API_KEY = searchKeyBackup;
  if (telegramKeyBackup === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = telegramKeyBackup;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('onboarding/persistence', () => {
  it('saveWizardRuntimeConfig writes workspace + server defaults', () => {
    saveWizardRuntimeConfig('/tmp/workspace-1');
    const configPath = getConfigPath();
    expect(existsSync(configPath)).toBe(true);

    const raw = parseConfigContent(readFileSync(configPath, 'utf-8'), configPath);
    const workspace = raw.workspace as Record<string, unknown>;
    const server = raw.server as Record<string, unknown>;

    expect(workspace.dir).toBe('/tmp/workspace-1');
    expect(server.host).toBe('127.0.0.1');
    expect(server.port).toBe(9210);
    expect(server.auth_mode).toBe('token');
  });

  it('saveWorkspaceDirToConfig and saveServerDefaultsToConfig preserve existing keys', () => {
    const configPath = getConfigPath();
    writeFileSync(configPath, JSON.stringify({ brain: { model: 'MiniMax-M2.5' } }, null, 2), 'utf-8');

    saveWorkspaceDirToConfig('/tmp/workspace-2');
    saveServerDefaultsToConfig();

    const raw = parseConfigContent(readFileSync(configPath, 'utf-8'), configPath);
    const brain = raw.brain as Record<string, unknown>;
    expect(brain.model).toBe('MiniMax-M2.5');
    expect((raw.workspace as Record<string, unknown>).dir).toBe('/tmp/workspace-2');
    expect((raw.server as Record<string, unknown>).port).toBe(9210);
  });

  it('upsertEnvVar inserts and updates env values', () => {
    const envPath = getEnvPath();
    upsertEnvVar('A_KEY', '1', envPath);
    upsertEnvVar('B_KEY', '2', envPath);
    upsertEnvVar('A_KEY', '3', envPath);

    const content = readFileSync(envPath, 'utf-8');
    expect(content).toContain('A_KEY=3');
    expect(content).toContain('B_KEY=2');
    expect((content.match(/^A_KEY=/gm) || []).length).toBe(1);
  });

  it('persistSearchKey and persistTelegramBotToken write env + process env', () => {
    persistSearchKey('search-key');
    persistTelegramBotToken('bot-token');

    expect(process.env.SEARCH1API_KEY).toBe('search-key');
    expect(process.env.TELEGRAM_BOT_TOKEN).toBe('bot-token');
    expect(readEnvVar('SEARCH1API_KEY')).toBe('search-key');
    expect(readEnvVar('TELEGRAM_BOT_TOKEN')).toBe('bot-token');
  });

  it('persistEnvValue stores provider API keys in encrypted storage when available', () => {
    const masterKey = generateMasterKey();

    persistEnvValue('OPENAI_API_KEY', 'openai-secret');

    expect(process.env.OPENAI_API_KEY).toBe('openai-secret');
    expect(readEnvVar('OPENAI_API_KEY')).toBe(null);
    expect(getSecret('OPENAI_API_KEY', masterKey)).toBe('openai-secret');
    expect(readPersistedSecret('OPENAI_API_KEY')).toBe('openai-secret');
  });

  it('persistEnvValue keeps non-secret config in .env even when encrypted storage is available', () => {
    generateMasterKey();

    persistEnvValue('MINIMAX_BASE_URL', 'https://api.minimax.chat/anthropic/v1');

    expect(process.env.MINIMAX_BASE_URL).toBe('https://api.minimax.chat/anthropic/v1');
    expect(readEnvVar('MINIMAX_BASE_URL')).toBe('https://api.minimax.chat/anthropic/v1');
  });

  it('persistSearchKey prefers the encrypted secret store when a master key exists', () => {
    const masterKey = generateMasterKey();

    persistSearchKey('encrypted-search-key');

    expect(process.env.SEARCH1API_KEY).toBe('encrypted-search-key');
    expect(readEnvVar('SEARCH1API_KEY')).toBe(null);
    expect(getSecret('SEARCH1API_KEY', masterKey)).toBe('encrypted-search-key');
    expect(readPersistedSecret('SEARCH1API_KEY')).toBe('encrypted-search-key');
  });

  it('validateOnboardingWriteContract reports missing keys and passes when complete', () => {
    saveWizardRuntimeConfig('/tmp/workspace-3');
    let check = validateOnboardingWriteContract({
      workspaceDir: '/tmp/workspace-3',
      requiredEnvKeys: ['SEARCH1API_KEY'],
    });
    expect(check.ok).toBe(false);
    expect(check.errors.join('\n')).toContain('SEARCH1API_KEY missing');

    persistSearchKey('search-ok');
    check = validateOnboardingWriteContract({
      workspaceDir: '/tmp/workspace-3',
      requiredEnvKeys: ['SEARCH1API_KEY'],
    });
    expect(check.ok).toBe(true);
    expect(check.errors).toHaveLength(0);
  });

  it('validateOnboardingWriteContract accepts required keys from encrypted secret storage', () => {
    saveWizardRuntimeConfig('/tmp/workspace-4');
    generateMasterKey();
    persistSearchKey('encrypted-ok');

    const check = validateOnboardingWriteContract({
      workspaceDir: '/tmp/workspace-4',
      requiredEnvKeys: ['SEARCH1API_KEY'],
    });

    expect(check.ok).toBe(true);
    expect(check.errors).toHaveLength(0);
  });
});
