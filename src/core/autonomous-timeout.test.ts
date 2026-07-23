import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  cfg: {
    telegram: {
      interactive_turn_timeout_ms: 120_000,
    },
    tools: {
      loops: {
        llm_call_timeout_ms: 300_000,
        max_elapsed_ms: 600_000,
      },
    },
  },
  updateConfigMock: vi.fn((path: string, value: unknown) => {
    if (path === 'tools.loops.llm_call_timeout_ms') {
      hoisted.cfg.tools.loops.llm_call_timeout_ms = Number(value);
    } else if (path === 'tools.loops.max_elapsed_ms') {
      hoisted.cfg.tools.loops.max_elapsed_ms = Number(value);
    } else if (path === 'telegram.interactive_turn_timeout_ms') {
      hoisted.cfg.telegram.interactive_turn_timeout_ms = Number(value);
    }
  }),
  logEventMock: vi.fn(),
}));

vi.mock('../config/index.js', () => ({
  getConfig: () => hoisted.cfg,
  updateConfig: hoisted.updateConfigMock,
}));

vi.mock('../store/events.js', () => ({
  log: hoisted.logEventMock,
}));

import {
  reportTimeoutAndMaybeTune,
  resetAutonomousTimeoutState,
} from './autonomous-timeout.js';

describe('core/autonomous-timeout', () => {
  beforeEach(() => {
    hoisted.cfg.tools.loops.llm_call_timeout_ms = 90_000;
    hoisted.cfg.tools.loops.max_elapsed_ms = 600_000;
    hoisted.cfg.telegram.interactive_turn_timeout_ms = 120_000;
    hoisted.updateConfigMock.mockClear();
    hoisted.logEventMock.mockClear();
    resetAutonomousTimeoutState();
    vi.useRealTimers();
  });

  it('applies tuning after repeated timeout signals', () => {
    const first = reportTimeoutAndMaybeTune({
      scope: 'gateway',
      tenantId: 'default',
      observedCallTimeoutMs: 300_000,
      observedLoopTimeoutMs: 600_000,
    });
    expect(first.applied).toBe(false);
    expect(first.reason).toBe('insufficient_timeout_signals');

    const second = reportTimeoutAndMaybeTune({
      scope: 'gateway',
      tenantId: 'default',
      observedCallTimeoutMs: 300_000,
      observedLoopTimeoutMs: 600_000,
    });
    expect(second.applied).toBe(true);
    expect(second.nextCallTimeoutMs).toBeGreaterThan(300_000);
    expect(second.nextLoopTimeoutMs).toBeGreaterThan(600_000);
    expect(hoisted.updateConfigMock).toHaveBeenCalledWith('tools.loops.llm_call_timeout_ms', second.nextCallTimeoutMs);
    expect(hoisted.updateConfigMock).toHaveBeenCalledWith('tools.loops.max_elapsed_ms', second.nextLoopTimeoutMs);
    expect(hoisted.logEventMock).toHaveBeenCalledTimes(1);
  });

  it('also tunes interactive turn timeout when timeout came from turn-level guard', () => {
    reportTimeoutAndMaybeTune({
      scope: 'gateway',
      tenantId: 'default',
      observedInteractiveTurnTimeoutMs: 120_000,
    });
    const second = reportTimeoutAndMaybeTune({
      scope: 'gateway',
      tenantId: 'default',
      observedInteractiveTurnTimeoutMs: 120_000,
    });
    expect(second.applied).toBe(true);
    expect(second.nextInteractiveTurnTimeoutMs).toBeGreaterThan(120_000);
    expect(hoisted.updateConfigMock).toHaveBeenCalledWith(
      'telegram.interactive_turn_timeout_ms',
      second.nextInteractiveTurnTimeoutMs,
    );
  });

  it('respects cooldown after an automatic tuning', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-03T00:00:00.000Z'));

    reportTimeoutAndMaybeTune({ scope: 'gateway', tenantId: 'default' });
    const applied = reportTimeoutAndMaybeTune({ scope: 'gateway', tenantId: 'default' });
    expect(applied.applied).toBe(true);

    const cooldownBlocked1 = reportTimeoutAndMaybeTune({ scope: 'gateway', tenantId: 'default' });
    expect(cooldownBlocked1.applied).toBe(false);

    const cooldownBlocked2 = reportTimeoutAndMaybeTune({ scope: 'gateway', tenantId: 'default' });
    expect(cooldownBlocked2.applied).toBe(false);
    expect(cooldownBlocked2.reason).toBe('cooldown_active');
  });

  it('tracks timeout windows per scope key', () => {
    const firstGateway = reportTimeoutAndMaybeTune({ scope: 'gateway', tenantId: 'default' });
    const firstDag = reportTimeoutAndMaybeTune({ scope: 'dag', tenantId: 'default' });
    expect(firstGateway.applied).toBe(false);
    expect(firstDag.applied).toBe(false);

    const secondDag = reportTimeoutAndMaybeTune({ scope: 'dag', tenantId: 'default' });
    expect(secondDag.applied).toBe(true);

    const secondGateway = reportTimeoutAndMaybeTune({ scope: 'gateway', tenantId: 'default' });
    expect(secondGateway.applied).toBe(true);
  });
});
