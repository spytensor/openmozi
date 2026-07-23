/**
 * Tool-source contract (UI narrative layer).
 *
 * Proves that the structured web sources a search/fetch tool returns survive
 * the full producer → broadcast → persistence → restore path, so both the live
 * WS frame and a reloaded session can render "searched N sources" with real
 * titles/urls instead of raw queries. Persistence runs regardless of connected
 * sockets, so none are needed.
 */
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { broadcastProgressEvent } from './websocket.js';
import { getSessionTimelinePage } from '../memory/session-timeline.js';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import { registerRunningTurn, clearRunningTurnsForTests } from '../core/turn-cancellation.js';
import { searchResultsToSources } from '../tools/web-tools.js';
import type { ToolSourceRef } from '../tools/types.js';

const TENANT = 'default';
const USER = 'u1';
const SESSION = 's1';
const CHAT = `${USER}:${SESSION}`;

interface ToolEventPayload {
  callId?: string;
  tool?: string;
  phase?: string;
  status?: string;
  result?: string;
  sources?: ToolSourceRef[];
}

function restoredToolEvents(): ToolEventPayload[] {
  const page = getSessionTimelinePage(SESSION, { tenantId: TENANT });
  return page.timeline
    .filter((item) => item.type === 'tool_event')
    .map((item) => item.data as ToolEventPayload);
}

let tmpDir: string;

beforeEach(() => {
  clearRunningTurnsForTests();
  tmpDir = setupTestDb().tmpDir;
  registerRunningTurn({ turnId: 'turn_A', tenantId: TENANT, chatId: CHAT, userId: USER, sessionId: SESSION });
});

afterEach(() => {
  clearRunningTurnsForTests();
  teardownTestDb(tmpDir);
});

describe('searchResultsToSources', () => {
  it('projects structured hits into capped title/url/snippet refs', () => {
    const sources = searchResultsToSources([
      { title: 'CPI Summary — June', url: 'https://bls.gov/cpi', snippet: 'The all items index rose 3.5 percent' },
      { title: '  ', url: 'https://bea.gov/pce', snippet: '' },
      { title: 'No URL entry' },
    ]);
    expect(sources).toEqual([
      { title: 'CPI Summary — June', url: 'https://bls.gov/cpi', snippet: 'The all items index rose 3.5 percent' },
      { title: undefined, url: 'https://bea.gov/pce', snippet: undefined },
    ]);
  });

  it('rejects non-web and oversized URLs — sources render as hrefs in the UI', () => {
    const sources = searchResultsToSources([
      { title: 'Evil', url: 'javascript:alert(1)' },
      { title: 'FTP', url: 'ftp://example.com/file' },
      { title: 'Huge', url: `https://example.com/${'a'.repeat(3000)}` },
      { title: 'Legit', url: 'https://example.com/ok' },
    ]);
    expect(sources).toEqual([{ title: 'Legit', url: 'https://example.com/ok', snippet: undefined }]);
  });

  it('caps the list at 10 entries and truncates long titles/snippets', () => {
    const many = Array.from({ length: 14 }, (_, i) => ({
      title: 'T'.repeat(500),
      url: `https://example.com/${i}`,
      snippet: 'S'.repeat(500),
    }));
    const sources = searchResultsToSources(many);
    expect(sources).toHaveLength(10);
    expect(sources[0].title).toHaveLength(200);
    expect(sources[0].snippet).toHaveLength(240);
  });
});

describe('tool sources survive WS broadcast + persistence + restore', () => {
  const SOURCES: ToolSourceRef[] = [
    { title: 'Consumer Price Index Summary', url: 'https://www.bls.gov/news.release/cpi.htm', snippet: 'The all items index rose 3.5 percent' },
    { title: 'Employment Situation', url: 'https://www.bls.gov/news.release/empsit.htm' },
  ];

  it('persists sources from a tool_result end frame merged onto its start frame', () => {
    broadcastProgressEvent({
      type: 'tool_call', taskId: 'task_1', toolName: 'web_search', toolCallId: 'call_1',
      intent: 'US CPI June', chatId: CHAT, tenantId: TENANT, sessionId: SESSION, turnId: 'turn_A', timestamp: 1000,
    });
    broadcastProgressEvent({
      type: 'tool_result', taskId: 'task_1', toolName: 'web_search', toolCallId: 'call_1',
      result: '1. Consumer Price Index Summary…', sources: SOURCES, elapsed_ms: 1200,
      chatId: CHAT, tenantId: TENANT, sessionId: SESSION, turnId: 'turn_A', timestamp: 1001,
    });

    const events = restoredToolEvents();
    expect(events).toHaveLength(1); // start + end merge onto one callId-keyed row
    expect(events[0].callId).toBe('call_1');
    expect(events[0].status).toBe('success');
    expect(events[0].sources).toEqual(SOURCES);
  });

  it('does not attach sources to error results and leaves sourceless tools unchanged', () => {
    broadcastProgressEvent({
      type: 'tool_result', taskId: 'task_1', toolName: 'run_command', toolCallId: 'call_2',
      result: 'ok', elapsed_ms: 10, chatId: CHAT, tenantId: TENANT, sessionId: SESSION, turnId: 'turn_A', timestamp: 2000,
    });
    broadcastProgressEvent({
      type: 'tool_result', taskId: 'task_1', toolName: 'web_search', toolCallId: 'call_3',
      error: 'search failed', elapsed_ms: 10, chatId: CHAT, tenantId: TENANT, sessionId: SESSION, turnId: 'turn_A', timestamp: 2001,
    });
    const byCall = new Map(restoredToolEvents().map((e) => [e.callId, e]));
    expect(byCall.get('call_2')?.sources).toBeUndefined();
    expect(byCall.get('call_3')?.status).toBe('error');
    expect(byCall.get('call_3')?.sources).toBeUndefined();
  });
});
