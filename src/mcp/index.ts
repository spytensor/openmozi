export { MCPConfigSchema, MCPServerConfigSchema, type MCPConfig, type MCPServerConfig } from './config.js';
export { createMCPBridge, type MCPBridge, type MCPServerStatus } from './bridge.js';

// ---------------------------------------------------------------------------
// Singleton accessor — set once at startup, read from handler
// ---------------------------------------------------------------------------

import type { MCPBridge } from './bridge.js';

let _bridge: MCPBridge | null = null;

/** Set the global MCP bridge instance (called during startup) */
export function setMCPBridge(bridge: MCPBridge | null): void {
  _bridge = bridge;
}

/** Get the global MCP bridge instance */
export function getMCPBridge(): MCPBridge | null {
  return _bridge;
}
