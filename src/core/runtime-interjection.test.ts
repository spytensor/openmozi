import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildRuntimeInterjection } from './runtime-interjection.js';

describe('core/runtime-interjection', () => {
  it('wraps every kind in the single envelope with the standing invisibility rules', () => {
    const gate = buildRuntimeInterjection('completion_gate', 'Status: pending\nRequired: verify.');
    expect(gate.role).toBe('user');
    expect(gate.content).toMatch(/^\[RUNTIME INTERJECTION:completion_gate\]\n/);
    expect(gate.content).toContain('Status: pending');
    expect(gate.content).toContain('INVISIBLE to the user');
    expect(gate.content).toContain('Never narrate self-correction');

    const trunc = buildRuntimeInterjection('truncation_continue', 'Continue where you left off.');
    expect(trunc.role).toBe('user');
    expect(trunc.content).toContain('[RUNTIME INTERJECTION:truncation_continue]');

    const kernel = buildRuntimeInterjection('kernel_directive', '[Runtime admission rejected] …');
    expect(kernel.role).toBe('system');
    expect(kernel.content).toContain('[RUNTIME INTERJECTION:kernel_directive]');
  });
});

describe('core/runtime-interjection — channel invariant (lint)', () => {
  // Root-cause contract (operator decision 2026-07-18): the runtime speaks to
  // the Brain mid-turn ONLY through buildRuntimeInterjection, so the standing
  // invisibility rules travel with every such message. A new mechanism that
  // inserts a raw user/system message into a brain loop bypasses the contract
  // and recreates the "MOZI talks to itself" incident — this test fails the
  // suite instead. Review finding 3 hardening: gateway + agents dirs are
  // scanned too, unshift/splice count as insertion, the role window is wider,
  // and slot-maintenance sites carry an explicit `interjection-lint-exempt`
  // marker instead of being silently invisible to the scan.
  const SCANNED_DIRS = ['core', 'gateway', 'agents'];
  const INSERT_PATTERN = /(?:loopMessages|injected|messages)\s*\.\s*(?:push|unshift|splice)\s*\(/;

  it('no raw user/system interjection inserts exist outside the module', () => {
    const srcRoot = join(__dirname, '..');
    const offenders: string[] = [];
    for (const dir of SCANNED_DIRS) {
      for (const file of readdirSync(join(srcRoot, dir))) {
        if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
        if (dir === 'core' && file === 'runtime-interjection.ts') continue;
        const source = readFileSync(join(srcRoot, dir, file), 'utf8');
        const lines = source.split('\n');
        lines.forEach((line, index) => {
          if (!INSERT_PATTERN.test(line)) return;
          const windowStart = Math.max(0, index - 4);
          const window = lines.slice(windowStart, index + 6).join('\n');
          if (window.includes('interjection-lint-exempt')) return;
          if (window.includes('buildRuntimeInterjection')) return;
          if (/role:\s*'(?:user|system)'/.test(window)) {
            offenders.push(`${dir}/${file}:${index + 1}`);
          }
        });
      }
    }
    expect(offenders).toEqual([]);
  });
});
