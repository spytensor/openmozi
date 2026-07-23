import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import yaml from 'js-yaml';
import { getConfigPath } from '../paths.js';

export type RawConfigObject = Record<string, unknown>;

interface ReadConfigResult {
  config: RawConfigObject;
  sourcePath: string | null;
  migratedFromLegacy: boolean;
}

function isJsonConfigPath(configPath: string): boolean {
  return extname(configPath).toLowerCase() === '.json';
}

function isCanonicalConfigFilename(configPath: string): boolean {
  return basename(configPath) === 'mozi.json';
}

function normalizeParsedObject(value: unknown): RawConfigObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as RawConfigObject;
}

export function parseConfigContent(content: string, configPath: string): RawConfigObject {
  const trimmed = content.trim();
  if (trimmed.length === 0) return {};
  if (isJsonConfigPath(configPath)) {
    return normalizeParsedObject(JSON.parse(trimmed));
  }
  return normalizeParsedObject(yaml.load(content));
}

export function stringifyConfigContent(configPath: string, config: RawConfigObject): string {
  if (isJsonConfigPath(configPath)) {
    return `${JSON.stringify(config, null, 2)}\n`;
  }
  return yaml.dump(config, { lineWidth: 120, noRefs: true });
}

export function readConfigObject(configPath: string): RawConfigObject {
  if (!existsSync(configPath)) return {};
  const content = readFileSync(configPath, 'utf-8');
  return parseConfigContent(content, configPath);
}

export function writeConfigObject(configPath: string, config: RawConfigObject): void {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, stringifyConfigContent(configPath, config), 'utf-8');
}

export function readConfigWithLegacyFallback(
  configPath = getConfigPath(),
  opts?: { migrateLegacyToCanonical?: boolean },
): ReadConfigResult {
  const legacySibling = join(dirname(configPath), 'config.yaml');

  let sourcePath: string | null = null;
  if (existsSync(configPath)) {
    sourcePath = configPath;
  } else if (isCanonicalConfigFilename(configPath) && existsSync(legacySibling)) {
    sourcePath = legacySibling;
  }

  if (!sourcePath) {
    return { config: {}, sourcePath: null, migratedFromLegacy: false };
  }

  const config = readConfigObject(sourcePath);
  let migratedFromLegacy = false;
  if (sourcePath === legacySibling && isCanonicalConfigFilename(configPath) && opts?.migrateLegacyToCanonical !== false) {
    try {
      writeConfigObject(configPath, config);
      migratedFromLegacy = true;
    } catch {
      // Non-fatal: preserve runtime compatibility even if canonical write fails.
    }
  }
  return { config, sourcePath, migratedFromLegacy };
}
