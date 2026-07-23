/**
 * WebSocket channel plugin — MOZI's built-in web UI transport.
 *
 * WebSocket runs inside the Fastify app and has no external credentials
 * beyond the shared JWT secret. It always boots with MOZI, so it has no
 * wizard step and no env keys. It IS listed in the registry so the UI and
 * capability manifest can describe it consistently.
 */

import type { ChannelPlugin } from '../registry.js';

export const websocketPlugin: ChannelPlugin = {
  id: 'websocket',
  label: 'WebSocket (Web UI)',
  description: 'Bundled React web UI. Enabled automatically when MOZI boots.',
  docsPath: 'docs/channels/websocket.md',
  envKeys: [],
  status: 'stable',
  capabilities: { direction: 'bidirectional', inboundMedia: true, outboundMedia: true, proactive: true, editing: false, deletion: false },

  isConfigured() {
    return true;
  },

  isChatId(value: string) {
    return value.startsWith('ws:') || value.startsWith('websocket:');
  },
};
