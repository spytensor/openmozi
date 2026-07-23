import { describe, expect, it } from 'vitest';
import {
  buildRuntimeTimeAnchor,
  buildRuntimeTimeRefreshDirective,
  buildRuntimeTimeSystemPrompt,
  isExplicitTimeRequest,
  stripUnrequestedTimePreamble,
} from './time-context.js';

describe('core/time-context', () => {
  it('builds deterministic anchor fields for a fixed date', () => {
    const now = new Date('2026-03-04T12:34:56.000Z');
    const anchor = buildRuntimeTimeAnchor(now);

    expect(anchor.utcIso).toBe('2026-03-04T12:34:56.000Z');
    expect(anchor.epochMs).toBe(now.getTime());
    expect(anchor.utcOffset).toMatch(/^[+-]\d{2}:\d{2}$/);
    expect(anchor.localIso).toMatch(/^2026-03-04T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    expect(anchor.timezone.length).toBeGreaterThan(0);
  });

  it('formats system prompt and refresh directive with authoritative fields', () => {
    const now = new Date('2026-03-04T12:34:56.000Z');
    const prompt = buildRuntimeTimeSystemPrompt(now);
    const directive = buildRuntimeTimeRefreshDirective(now);

    expect(prompt).toContain('[RUNTIME TIME FACTS');
    expect(prompt).toContain('utc_iso=2026-03-04T12:34:56.000Z');
    expect(prompt).toContain('Do NOT prepend a time banner');
    expect(directive).toContain('[INTERNAL DIRECTIVE');
    expect(directive).toContain('utc_iso=2026-03-04T12:34:56.000Z');
  });

  it('detects explicit time/date requests in English and Chinese', () => {
    expect(isExplicitTimeRequest('what is the current time in Dubai?')).toBe(true);
    expect(isExplicitTimeRequest('现在几点了')).toBe(true);
    expect(isExplicitTimeRequest('what is the project status')).toBe(false);
  });

  it('strips leading system time banner when user did not ask for time', () => {
    const text = '[系统时间: 2026-03-04 18:55:00 UTC+4]\n\n机场当前正常运行。';
    const cleaned = stripUnrequestedTimePreamble(text, '查一下机场运行情况');
    expect(cleaned).toBe('机场当前正常运行。');
  });

  it('keeps system time banner when user explicitly asks for time', () => {
    const text = '[系统时间: 2026-03-04 18:55:00 UTC+4]\n\n现在是晚上。';
    const cleaned = stripUnrequestedTimePreamble(text, '现在几点？');
    expect(cleaned).toBe(text);
  });
});
