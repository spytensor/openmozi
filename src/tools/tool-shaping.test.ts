import { describe, expect, it } from 'vitest';
import { ALL_TOOLS } from './definitions.js';
import {
  activateToolsForExecution,
  shapePromptMessagesForExecution,
  shapeToolsForExecution,
} from './tool-shaping.js';

function names(result: ReturnType<typeof shapeToolsForExecution>): string[] {
  return result.tools.map(tool => tool.function.name);
}

describe('model-driven progressive tool loading', () => {
  it('exposes the same small bootstrap surface for every request', () => {
    const simple = shapeToolsForExecution({ tools: ALL_TOOLS });
    const complex = shapeToolsForExecution({ tools: ALL_TOOLS });

    expect(new Set(names(simple))).toEqual(new Set([
      'get_capabilities', 'activate_tools', 'use_skill', 'decompose_task',
    ]));
    expect(names(complex)).toEqual(names(simple));
    expect(simple.taskProfile).toBe('model_driven');
    expect(simple.shapedCount).toBe(4);
    expect(simple.deferredCount).toBe(ALL_TOOLS.length - 4);
    expect(simple.schemaTokensEstimate).toBeLessThan(Math.ceil(JSON.stringify(ALL_TOOLS).length / 4) * 0.25);
  });

  it('keeps ready dynamic tools deferred and discoverable by description', () => {
    const dynamic = {
      type: 'function' as const,
      function: {
        name: 'tenant_market_lookup',
        description: 'Look up the tenant market ledger.',
        parameters: { type: 'object' },
      },
    };
    const shaped = shapeToolsForExecution({ tools: [...ALL_TOOLS, dynamic] });

    expect(names(shaped)).not.toContain('tenant_market_lookup');
    expect(shaped.toolCatalog).toContain('tenant_market_lookup: Look up the tenant market ledger.');
  });

  it('keeps skill installation discoverable and activatable for every request', () => {
    const shaped = shapeToolsForExecution({ tools: ALL_TOOLS });

    expect(names(shaped)).not.toContain('install_skill');
    expect(shaped.toolCatalog).toContain('install_skill:');
    expect(activateToolsForExecution(shaped, ALL_TOOLS, ['install_skill'])).toEqual(['install_skill']);
    expect(names(shaped)).toContain('install_skill');
  });

  it('activates only model-selected full schemas for the current loop', () => {
    const shaped = shapeToolsForExecution({ tools: ALL_TOOLS });
    const activated = activateToolsForExecution(
      shaped,
      ALL_TOOLS,
      ['web_search', 'write_file', 'set_cron_task'],
    );

    expect(activated).toEqual(['web_search', 'write_file', 'set_cron_task']);
    expect(names(shaped)).toEqual(expect.arrayContaining(activated));
    expect(names(shaped)).not.toContain('shell_exec');
    expect(shaped.shapedCount).toBe(7);
  });

  it('fails loudly when activation names a tool outside the turn snapshot', () => {
    const shaped = shapeToolsForExecution({ tools: ALL_TOOLS });
    expect(() => activateToolsForExecution(shaped, ALL_TOOLS, ['not_ready']))
      .toThrow('Tool "not_ready" is not ready in this turn');
  });

  it('rewrites active names, adds the compact catalog, and preserves capability guidance', () => {
    const shaped = shapeToolsForExecution({ tools: ALL_TOOLS });
    const prompt = shapePromptMessagesForExecution([{
      role: 'system',
      content: [
        '# SOUL.md',
        '## Available Tools\n\nread_file, shell_exec\n\nUse these tools when the user asks.',
        '## Runtime Capability Contract (Authoritative)\n- task_decomposition: enabled',
      ].join('\n\n---\n\n'),
    }], shaped);

    const system = String(prompt[0]?.content);
    for (const name of ['get_capabilities', 'activate_tools', 'use_skill', 'decompose_task']) {
      expect(system).toContain(name);
    }
    expect(system).toContain('## Tool Catalog');
    expect(system).toContain('shell_exec:');
    expect(system).toContain('Runtime Capability Contract');
    expect(system).not.toContain('read_file, shell_exec\n\nUse these tools when the user asks.');
  });

  it('updates active names without duplicating the catalog', () => {
    const shaped = shapeToolsForExecution({ tools: ALL_TOOLS });
    const initial = shapePromptMessagesForExecution([{ role: 'system', content: 'You are MOZI.' }], shaped);
    activateToolsForExecution(shaped, ALL_TOOLS, ['web_search']);
    const updated = shapePromptMessagesForExecution(initial, shaped);
    const system = String(updated[0]?.content);

    expect(system).toContain('web_search');
    expect(system.match(/## Tool Catalog/g)).toHaveLength(1);
  });

  it('removes the tenant capability contract on child surfaces', () => {
    const shaped = shapeToolsForExecution({ tools: ALL_TOOLS });
    const prompt = shapePromptMessagesForExecution([{
      role: 'system',
      content: 'Identity\n\n---\n\n## Runtime Capability Contract (Authoritative)\n- desktop: enabled',
    }], shaped, { childSurface: true });

    expect(String(prompt[0]?.content)).not.toContain('Runtime Capability Contract');
    expect(String(prompt[0]?.content)).toContain('## Tool Catalog');
  });
});
