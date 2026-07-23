import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { MoziConfigSchema } from '../config/index.js';
import { buildRuntimeCapabilityManifest } from './capability-manifest.js';

type PackageJson = {
  version?: string;
};

function readPackageJson(path: string): PackageJson {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf-8')) as PackageJson;
}

describe('core/release-gate', () => {
  it('keeps release package versions in sync across root, ui, and desktop', () => {
    const rootVersion = readPackageJson('../../package.json').version;
    expect(rootVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(readPackageJson('../../ui/package.json').version).toBe(rootVersion);
    expect(readPackageJson('../../desktop/package.json').version).toBe(rootVersion);
  });

  it('loads config defaults and builds the capability manifest', () => {
    const config = MoziConfigSchema.parse({});
    const manifest = buildRuntimeCapabilityManifest(config, ['shell_exec'], 'default');

    expect(config.server.port).toBe(9210);
    expect(config.security.registration).toBe('invite');
    expect(manifest.metadata.max_parallel_agents).toBe(config.system.max_parallel_agents);
    expect(manifest.metadata.registered_tools).toEqual(['shell_exec']);
    expect(manifest.built_in.some((capability) => capability.id === 'direct_brain_execution')).toBe(true);
  });
});
