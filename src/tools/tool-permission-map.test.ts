import { describe, it, expect } from 'vitest';
import { ALL_TOOLS } from './definitions.js';
import {
  DYNAMIC_TOOL_PERMISSION,
  TOOL_PERMISSION_MAP,
  assertToolPermissionCoverage,
  getToolPermission,
} from './tool-permission-map.js';
import { getRequiredLevel, isValidLevel } from '../security/permissions.js';

describe('tool-permission-map', () => {
  it('every entry maps to an ACTION_REQUIREMENTS key understood by permissions.ts', () => {
    for (const [toolName, perm] of Object.entries(TOOL_PERMISSION_MAP)) {
      const actionKey = `${perm.category}.${perm.action}`;
      const required = getRequiredLevel(actionKey);
      expect(isValidLevel(required), `${toolName} → ${actionKey} resolved to invalid level ${required}`).toBe(true);
    }
  });

  it('covers every built-in tool', () => {
    expect(() => assertToolPermissionCoverage(ALL_TOOLS)).not.toThrow();
    expect(Object.keys(TOOL_PERMISSION_MAP).sort()).toEqual(
      ALL_TOOLS.map(tool => tool.function.name).sort(),
    );
  });

  it('fails closed for unknown and dynamic tool names', () => {
    expect(getToolPermission('this_tool_does_not_exist')).toEqual(DYNAMIC_TOOL_PERMISSION);
    expect(getRequiredLevel(`${DYNAMIC_TOOL_PERMISSION.category}.${DYNAMIC_TOOL_PERMISSION.action}`))
      .toBe('L2_SHELL_EXEC');
  });

  it('getToolPermission returns category+action for mapped tools', () => {
    expect(getToolPermission('web_fetch')).toEqual({ category: 'network', action: 'read' });
    expect(getToolPermission('shell_exec')).toEqual({ category: 'shell', action: 'execute' });
  });

  it('maps web reads to L2 and desktop host control to L3', () => {
    for (const name of ['web_search', 'web_fetch', 'browser_extract', 'browser_assert']) {
      const perm = getToolPermission(name);
      expect(perm).toEqual({ category: 'network', action: 'read' });
      expect(getRequiredLevel(`${perm!.category}.${perm!.action}`)).toBe('L2_SHELL_EXEC');
    }

    for (const [name, perm] of Object.entries(TOOL_PERMISSION_MAP)) {
      if (!name.startsWith('desktop_')) continue;
      expect(perm).toEqual({ category: 'desktop', action: 'control' });
      expect(getRequiredLevel(`${perm.category}.${perm.action}`)).toBe('L3_FULL_ACCESS');
    }

    expect(getToolPermission('browser_open')).toEqual({ category: 'network', action: 'request' });
    expect(getToolPermission('browser_click')).toEqual({ category: 'network', action: 'request' });
    expect(getToolPermission('browser_type')).toEqual({ category: 'network', action: 'request' });
    expect(getToolPermission('git_push')).toEqual({ category: 'network', action: 'request' });
  });

  it('protects executable runtime control and external actions', () => {
    expect(getToolPermission('create_tool')).toEqual({ category: 'shell', action: 'execute' });
    expect(getToolPermission('run_task')).toEqual({ category: 'shell', action: 'execute' });
    expect(getToolPermission('restart_self')).toEqual({ category: 'runtime', action: 'restart' });
    expect(getToolPermission('connector_execute')).toEqual({ category: 'network', action: 'request' });
    expect(getToolPermission('send_progress_report')).toEqual({ category: 'external', action: 'send' });
  });
});
