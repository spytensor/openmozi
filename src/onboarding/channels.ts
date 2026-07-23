/**
 * Registry-driven channel configuration for the onboarding wizard.
 *
 * Replaces the hardcoded Telegram + WeChat prompts. Every plugin registered
 * in `channelRegistry` with a `runWizard` method gets a selection entry;
 * the user picks which to configure and the plugin owns its own flow.
 */

import * as p from '@clack/prompts';
import { isCancel } from '@clack/prompts';
import { channelRegistry, type ChannelPlugin } from '../channels/registry.js';
import { installBuiltinChannelPlugins } from '../channels/plugins/index.js';
import { persistEnvValue } from './persistence.js';

/** Ensures all built-in plugins are loaded before the wizard reads the registry. */
export function ensureChannelsInstalled(): void {
  installBuiltinChannelPlugins();
}

/** Plugins that expose an interactive setup flow (excludes always-on channels like websocket). */
export function getConfigurableChannels(): ChannelPlugin[] {
  return channelRegistry.list().filter((plugin) => typeof plugin.runWizard === 'function');
}

interface ChannelSelectionResult {
  /** Env keys that were persisted (for `validateOnboardingWriteContract`). */
  persistedEnvKeys: string[];
}

/**
 * Let the user pick which channels to configure in a fresh setup, then run
 * each selected plugin's wizard in order.
 */
export async function runChannelSelection(options: {
  env?: NodeJS.ProcessEnv;
} = {}): Promise<ChannelSelectionResult> {
  ensureChannelsInstalled();
  const env = options.env ?? process.env;
  const plugins = getConfigurableChannels();
  if (plugins.length === 0) {
    return { persistedEnvKeys: [] };
  }

  const choices = plugins.map((plugin) => ({
    value: plugin.id,
    label: plugin.label,
    hint: formatPluginHint(plugin, env),
  }));

  const selection = await p.multiselect({
    message: 'Which messaging channels would you like to configure? (Space to toggle, Enter to confirm)',
    options: choices,
    required: false,
    initialValues: [],
  });

  if (isCancel(selection)) {
    p.cancel('Onboarding cancelled.');
    process.exit(0);
  }

  const selectedIds = (selection as string[]) ?? [];
  const persistedEnvKeys: string[] = [];

  for (const id of selectedIds) {
    const plugin = channelRegistry.get(id);
    if (!plugin?.runWizard) continue;
    p.log.info(`── ${plugin.label} ──`);
    try {
      const result = await plugin.runWizard({ prompts: p as typeof import('@clack/prompts') });
      if (!result) {
        p.log.warn(`${plugin.label}: skipped.`);
        continue;
      }
      for (const [key, value] of Object.entries(result.env)) {
        persistEnvValue(key, value);
        persistedEnvKeys.push(key);
      }
      if (Object.keys(result.env).length > 0) {
        p.log.success(`${plugin.label}: credentials saved.`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      p.log.warn(`${plugin.label}: setup failed — ${message}`);
    }
  }

  return { persistedEnvKeys };
}

/** Run the wizard for a single plugin (update-mode menu handler). */
export async function runChannelUpdate(id: string): Promise<boolean> {
  ensureChannelsInstalled();
  const plugin = channelRegistry.get(id);
  if (!plugin) {
    p.log.error(`Unknown channel: ${id}`);
    return false;
  }
  if (!plugin.runWizard) {
    p.log.info(`${plugin.label} has no interactive setup — see ${plugin.docsPath}.`);
    return false;
  }

  const currentValues = plugin.envKeys
    .map((key) => [key, process.env[key]] as const)
    .filter(([, v]) => Boolean(v));
  if (currentValues.length > 0) {
    for (const [key, value] of currentValues) {
      const masked = value!.length > 10 ? `${value!.slice(0, 6)}…${value!.slice(-4)}` : '•••';
      p.log.info(`Current ${key}: ${masked}`);
    }
  } else {
    p.log.info(`${plugin.label} not yet configured.`);
  }

  const result = await plugin.runWizard({ prompts: p as typeof import('@clack/prompts') });
  if (!result) {
    p.log.info('Cancelled.');
    return false;
  }
  for (const [key, value] of Object.entries(result.env)) {
    persistEnvValue(key, value);
  }
  p.log.success(`${plugin.label} updated.`);
  return true;
}

/** Build update-menu entries dynamically from the registry. */
export function buildChannelUpdateMenuItems(): Array<{
  value: `channel:${string}`;
  label: string;
  hint: string;
}> {
  ensureChannelsInstalled();
  return getConfigurableChannels().map((plugin) => ({
    value: `channel:${plugin.id}` as const,
    label: `Configure ${plugin.label}`,
    hint: plugin.isConfigured() ? 'Update credentials' : 'Add credentials',
  }));
}

function formatPluginHint(plugin: ChannelPlugin, env: NodeJS.ProcessEnv): string {
  const tags: string[] = [];
  if (plugin.status === 'beta') tags.push('beta');
  if (plugin.isConfigured(env)) tags.push('configured');
  if (plugin.capabilities.direction === 'outgoing_only') tags.push('outgoing only');
  if (!plugin.capabilities.inboundMedia || !plugin.capabilities.outboundMedia) tags.push('text only');
  if (!plugin.capabilities.proactive) tags.push('no proactive messaging');
  const suffix = tags.length > 0 ? ` [${tags.join(', ')}]` : '';
  return `${plugin.description}${suffix}`;
}
