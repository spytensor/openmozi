/**
 * Channel plugin registry.
 *
 * Every user-facing messaging channel (Telegram, Discord, Slack, ...) registers
 * a `ChannelPlugin` here. `src/index.ts` iterates the registry to start/stop
 * channels; the onboarding wizard iterates the registry to let the user pick
 * which ones to configure; proactive notifications iterate the registry to
 * find the right sender for a given chatId.
 *
 * Design notes:
 * - Channels own their own transport (long-poll, webhook, WebSocket) and their
 *   own wizard flow. The registry only defines the contract.
 * - `chatId` values carry the channel namespace (e.g. `tg:123`, `discord:456`)
 *   or — for legacy channels — a pattern that `isChatId` can recognize.
 */

import type { FastifyInstance } from 'fastify';
import type pino from 'pino';
import type { MessageHandler } from './telegram.js';

/** Values the wizard persists after a successful channel configuration. */
export interface ChannelWizardResult {
  /** Env-var key → value pairs to write into ~/.mozi/.env */
  env: Record<string, string>;
  /** Optional extra config patch for mozi.config.json (rare). */
  config?: Record<string, unknown>;
}

/** Runtime dependencies handed to `start`. */
export interface ChannelStartContext {
  /** Normalized handler invoked for every inbound message. */
  handler: MessageHandler;
  /** Pino logger scoped to this channel. */
  logger: pino.Logger;
  /** Fastify app (for channels that register HTTP/WS routes). May be null. */
  fastify: FastifyInstance | null;
  /** JWT secret for routes that require auth. */
  jwtSecret: string;
  /** Full MOZI config snapshot (channels may read their own section). */
  config: unknown;
}

/** What a running channel exposes back to the runtime. */
export interface ChannelRuntime {
  /** Graceful stop. Called on SIGINT/SIGTERM. */
  stop(signal?: string): Promise<void> | void;
  /**
   * Attempt to deliver a proactive message. Return `false` if the chatId
   * does not belong to this channel (lets the router try the next one).
   */
  sendDirect?(chatId: string, text: string): Promise<boolean>;
  /** Notify a user that pairing was approved. Return `true` if delivered. */
  notifyPairingApproved?(userId: string, username: string): Promise<boolean>;
}

/** Clack-powered wizard context, injected by the onboarding runner. */
export interface ChannelWizardContext {
  prompts: typeof import('@clack/prompts');
}

export interface ChannelCapabilities {
  direction: 'bidirectional' | 'outgoing_only';
  inboundMedia: boolean;
  outboundMedia: boolean;
  proactive: boolean;
  editing: boolean;
  deletion: boolean;
}

/** Describes a channel plugin. */
export interface ChannelPlugin {
  /** Stable identifier — lowercase, used in chatId prefixes and env filtering. */
  readonly id: string;
  /** Short human label shown in UI. */
  readonly label: string;
  /** One-line blurb describing the channel (shown in wizard hint). */
  readonly description: string;
  /** Repo-relative path to the configuration tutorial (e.g. `docs/channels/discord.md`). */
  readonly docsPath: string;
  /** Env vars this plugin reads. Used by persistence for masking/reset. */
  readonly envKeys: readonly string[];
  /** Maturity marker. `beta` surfaces a warning in the wizard. */
  readonly status: 'stable' | 'beta';
  /** Transport operations that are actually wired in this adapter. */
  readonly capabilities: ChannelCapabilities;

  /** Is this channel currently configured (credentials present)? */
  isConfigured(env?: NodeJS.ProcessEnv): boolean;
  /**
   * Does `value` look like a chatId routed to this channel? Used by
   * proactive-notifier to pick the right sender.
   */
  isChatId(value: string): boolean;
  /**
   * Start the channel. Return `null` if startup was skipped (e.g. missing
   * credentials). Throwing means a hard error.
   *
   * Optional: legacy channels (telegram, websocket) are booted directly from
   * `src/index.ts` for historical reasons. Those plugins omit `start` and
   * register proactive senders separately. New channels always implement it.
   */
  start?(ctx: ChannelStartContext): Promise<ChannelRuntime | null>;
  /**
   * Interactive wizard step. Called only if the user selects this channel.
   * Return `null` if the user cancelled or skipped.
   */
  runWizard?(ctx: ChannelWizardContext): Promise<ChannelWizardResult | null>;
}

class ChannelRegistry {
  private plugins = new Map<string, ChannelPlugin>();

  register(plugin: ChannelPlugin): void {
    if (this.plugins.has(plugin.id)) {
      throw new Error(`Channel plugin "${plugin.id}" already registered`);
    }
    this.plugins.set(plugin.id, plugin);
  }

  unregister(id: string): void {
    this.plugins.delete(id);
  }

  list(): ChannelPlugin[] {
    return Array.from(this.plugins.values());
  }

  get(id: string): ChannelPlugin | undefined {
    return this.plugins.get(id);
  }

  /** Find the plugin (if any) that claims the given chatId. */
  findByChatId(value: string): ChannelPlugin | undefined {
    for (const plugin of this.plugins.values()) {
      if (plugin.isChatId(value)) return plugin;
    }
    return undefined;
  }

  /** Test-only: wipe all plugins. */
  clear(): void {
    this.plugins.clear();
  }
}

/**
 * Start every registered plugin that has a `start` method. Returns a map of
 * running runtimes keyed by plugin id so the caller can wire `stop` into
 * shutdown.
 */
export async function startRegisteredChannels(
  registry: Pick<ChannelRegistry, 'list'>,
  ctx: ChannelStartContext,
): Promise<Map<string, ChannelRuntime>> {
  const runtimes = new Map<string, ChannelRuntime>();
  for (const plugin of registry.list()) {
    if (!plugin.start) continue;
    if (!plugin.isConfigured()) {
      ctx.logger.debug({ channel: plugin.id }, 'Skipping unconfigured channel');
      continue;
    }
    try {
      const runtime = await plugin.start(ctx);
      if (runtime) runtimes.set(plugin.id, runtime);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.logger.error({ channel: plugin.id, err: message }, 'Channel plugin start failed');
    }
  }
  return runtimes;
}

export const channelRegistry = new ChannelRegistry();
