import { describe, expect, it } from 'vitest';
import { detectBuildSurface, getBuildInfo } from './build-info.js';

describe('runtime build identity', () => {
  it('detects product surface from runtime ownership', () => {
    expect(detectBuildSurface({ MOZI_DESKTOP: '1' })).toBe('desktop');
    expect(detectBuildSurface({ MOZI_HOME: '/data' })).toBe('docker');
    expect(detectBuildSurface({})).toBe('source');
  });

  it('returns a complete truthful fallback outside a bundled build', () => {
    expect(getBuildInfo({})).toEqual({
      version: '0.0.0-dev',
      commit: 'unknown',
      buildTime: 'unknown',
      channel: 'dev',
      surface: 'source',
    });
  });
});
