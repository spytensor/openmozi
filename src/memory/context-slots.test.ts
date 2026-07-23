import { describe, expect, it } from 'vitest';
import {
  buildSystemSlotSpecs,
  fitActiveSkillsSlot,
  fitLineSlot,
  fitTextSlot,
  normalizeLine,
  orderSystemSlotsForAllocation,
  type SlotSpec,
} from './context-slots.js';
import { estimateTokens } from './token-counter.js';

function spec(name: SlotSpec['name'], priority: number): SlotSpec {
  return {
    name,
    priority,
    tokenCap: 100,
    dedupeRule: 'exact',
    freshnessRule: 'per_request',
    fallbackRule: 'trim',
  };
}

describe('context slot allocation contract', () => {
  it('orders deliberately shuffled specs by priority with an explicit declaration-order tie break', () => {
    const ordered = orderSystemSlotsForAllocation([
      spec('skills', 10),
      spec('identity', 100),
      spec('project_knowledge', 50),
      spec('user_profile', 50),
    ]);

    expect(ordered.map(slot => slot.name)).toEqual([
      'identity',
      'project_knowledge',
      'user_profile',
      'skills',
    ]);
  });

  it('declares independent ceilings that intentionally total 1.38 of a large budget', () => {
    const specs = buildSystemSlotSpecs(10_000);

    expect(specs.reduce((total, slot) => total + slot.tokenCap, 0)).toBe(13_800);
    expect(specs.find(slot => slot.name === 'session_deliverables')?.fallbackRule).toBe('trim');
    expect(specs.find(slot => slot.name === 'episodic_digests')?.fallbackRule).toBe('trim');
    expect(specs.some(slot => slot.fallbackRule === 'summary')).toBe(false);
  });
});

describe('context slot fallback contract', () => {
  it('trims text within the cap, omits atomically, and rejects summary for system slots', () => {
    const content = 'alpha '.repeat(100);
    const trimmed = fitTextSlot(content, 5, 'trim');
    const omitted = fitTextSlot(content, 5, 'omit');

    expect(trimmed.fallbackApplied).toBe('trimmed');
    expect(trimmed.usedTokens).toBeLessThanOrEqual(5);
    expect(omitted).toEqual({ usedTokens: 0, itemCount: 0, fallbackApplied: 'omitted' });
    expect(() => fitTextSlot(content, 5, 'summary')).toThrow(/do not support summary fallback/);
  });

  it('does not commit line dedupe state when omit rejects an oversized slot', () => {
    const seen = new Set<string>();
    const lines = ['alpha', 'beta'];
    const oneLineCap = estimateTokens('## Evidence\nalpha');

    const omitted = fitLineSlot('Evidence', lines, oneLineCap, seen, 'omit');
    expect(omitted.fallbackApplied).toBe('omitted');
    expect(seen.size).toBe(0);

    const laterTrim = fitLineSlot('Later', ['alpha'], 100, seen, 'trim');
    expect(laterTrim.content).toContain('alpha');
    expect(seen.has(normalizeLine('alpha'))).toBe(true);
  });

  it('commits every deduped line only after a complete omit-policy slot fits', () => {
    const seen = new Set<string>(['already seen']);
    const lines = ['already seen', 'alpha', 'alpha', 'beta'];
    const fullCap = estimateTokens('## Evidence\nalpha\nbeta');

    const result = fitLineSlot('Evidence', lines, fullCap, seen, 'omit');

    expect(result.fallbackApplied).toBe('none');
    expect(result.itemCount).toBe(2);
    expect([...seen]).toEqual(['already seen', 'alpha', 'beta']);
  });

  it('trims line slots within budget and reports a zero-budget omission truthfully', () => {
    const seen = new Set<string>();
    const oneLineCap = estimateTokens('## Evidence\nalpha');

    const trimmed = fitLineSlot('Evidence', ['alpha', 'beta'], oneLineCap, seen, 'trim');
    expect(trimmed.fallbackApplied).toBe('trimmed');
    expect(trimmed.usedTokens).toBeLessThanOrEqual(oneLineCap);
    expect(trimmed.content).toContain('alpha');
    expect(trimmed.content).not.toContain('beta');
    expect([...seen]).toEqual(['alpha']);

    expect(fitLineSlot('Evidence', ['gamma'], 0, new Set(), 'omit')).toEqual({
      usedTokens: 0,
      itemCount: 0,
      fallbackApplied: 'omitted',
    });
  });

  it('applies omit and summary rules to active-skill slots too', () => {
    const skills = [{
      name: 'large-skill',
      description: 'Large skill',
      instructions: 'instruction '.repeat(100),
    }];

    expect(fitActiveSkillsSlot(skills, 5, 'omit').fallbackApplied).toBe('omitted');
    expect(() => fitActiveSkillsSlot(skills, 5, 'summary')).toThrow(/do not support summary fallback/);
  });
});
