import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { broadcastArtifactEvent } from '../channels/websocket.js';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import { getWorkspaceDir } from '../tools/workspace-policy.js';
import { compileIntelligentContext } from './context-builder.js';
import { createSession } from './sessions.js';

describe('session deliverable context production wiring', () => {
  let tmpDir: string;
  let previousMoziWorkspaces: string | undefined;

  beforeEach(() => {
    ({ tmpDir } = setupTestDb());
    previousMoziWorkspaces = process.env.MOZI_WORKSPACES;
    process.env.MOZI_WORKSPACES = join(tmpDir, 'user-workspaces');
  });

  afterEach(() => {
    if (previousMoziWorkspaces === undefined) delete process.env.MOZI_WORKSPACES;
    else process.env.MOZI_WORKSPACES = previousMoziWorkspaces;
    teardownTestDb(tmpDir);
  });

  it('reads a file_v1 artifact persisted by the real WebSocket artifact path on the next turn', async () => {
    const tenantId = 'deliverable-wiring-tenant';
    const userId = 'deliverable-wiring-user';
    const session = createSession(userId, 'Wiring', tenantId);
    const workspace = getWorkspaceDir(userId);
    mkdirSync(workspace, { recursive: true });
    const path = join(workspace, 'wired-report.pdf');
    writeFileSync(path, '%PDF-1.4\nwired');

    broadcastArtifactEvent({
      type: 'open',
      artifact: {
        id: 'file-wired-report',
        plugin_id: 'file_v1',
        title: 'Wired report',
        status: 'completed',
        collapsed_by_default: false,
        fallback_text: 'Wired report',
        data: { path, filename: 'wired-report.pdf' },
        updated_at: new Date().toISOString(),
      },
    }, userId, session.id, tenantId, 'turn_bg_wiring');

    const compiled = await compileIntelligentContext(
      userId,
      'sys',
      'Open the report you just made.',
      tenantId,
      userId,
      session.id,
    );

    const systemText = compiled.messages
      .filter(message => message.role === 'system')
      .map(message => message.content)
      .join('\n');
    expect(systemText).toContain('## Current Session Deliverables');
    expect(systemText).toContain(realpathSync(path));
  });
});
