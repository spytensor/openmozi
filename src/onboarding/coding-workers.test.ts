import { describe, expect, it } from 'vitest';
import {
  buildCodingWorkerConfig,
  detectCodingWorkers,
  recommendRouting,
  type CodingWorkerProbe,
} from './coding-workers.js';

describe('onboarding/coding-workers', () => {
  it('detects coding workers from PATH (real system check)', () => {
    const probes = detectCodingWorkers();

    expect(probes).toHaveLength(2);
    for (const probe of probes) {
      expect(probe.id).toBeTruthy();
      expect(probe.name).toBeTruthy();
      expect(probe.command).toBeTruthy();
      expect(typeof probe.installed).toBe('boolean');
      expect(typeof probe.authorized).toBe('boolean');
      expect(probe.installHint).toBeTruthy();
      expect(probe.authHint).toBeTruthy();

      if (probe.installed) {
        expect(probe.commandPath).toBeTruthy();
      }
    }
  });

  it('recommendRouting returns auto when multiple workers are ready', () => {
    const probes: CodingWorkerProbe[] = [
      { id: 'claude_code', name: 'Claude Code', command: 'claude', installed: true, commandPath: '/usr/bin/claude', version: '2.1', authorized: true, authHint: '', installHint: '' },
      { id: 'codex_cli', name: 'Codex CLI', command: 'codex', installed: true, commandPath: '/usr/bin/codex', version: '0.111', authorized: true, authHint: '', installHint: '' },
    ];

    expect(recommendRouting(probes)).toBe('auto');
  });

  it('recommendRouting returns the single ready worker when only one is available', () => {
    const probes: CodingWorkerProbe[] = [
      { id: 'claude_code', name: 'Claude Code', command: 'claude', installed: true, commandPath: '/usr/bin/claude', version: '2.1', authorized: true, authHint: '', installHint: '' },
      { id: 'codex_cli', name: 'Codex CLI', command: 'codex', installed: false, commandPath: null, version: null, authorized: false, authHint: '', installHint: '' },
    ];

    expect(recommendRouting(probes)).toBe('claude_code');
  });

  it('recommendRouting returns auto when no workers are ready', () => {
    const probes: CodingWorkerProbe[] = [
      { id: 'claude_code', name: 'Claude Code', command: 'claude', installed: false, commandPath: null, version: null, authorized: false, authHint: '', installHint: '' },
      { id: 'codex_cli', name: 'Codex CLI', command: 'codex', installed: false, commandPath: null, version: null, authorized: false, authHint: '', installHint: '' },
    ];

    expect(recommendRouting(probes)).toBe('auto');
  });

  it('buildCodingWorkerConfig produces correct config', () => {
    const probes: CodingWorkerProbe[] = [
      { id: 'claude_code', name: 'Claude Code', command: 'claude', installed: true, commandPath: '/usr/bin/claude', version: '2.1', authorized: true, authHint: '', installHint: '' },
      { id: 'codex_cli', name: 'Codex CLI', command: 'codex', installed: true, commandPath: '/usr/bin/codex', version: '0.111', authorized: false, authHint: '', installHint: '' },
    ];

    const config = buildCodingWorkerConfig(probes, 'claude_code');
    expect(config.routing).toBe('claude_code');
    expect(config.available).toEqual(['claude_code']);
  });
});
