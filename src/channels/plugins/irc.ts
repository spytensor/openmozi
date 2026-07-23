import pino from 'pino';
import type {
  ChannelPlugin,
  ChannelRuntime,
  ChannelStartContext,
  ChannelWizardContext,
  ChannelWizardResult,
} from '../registry.js';
import {
  createIrcAdapter,
  isIrcChatId,
  parseIrcChannels,
  sendDirectMessage,
  validateConnection,
  type IrcConfig,
} from '../irc.js';

const logger = pino({ name: 'mozi:channel:irc' });

function loadConfigFromEnv(): IrcConfig | null {
  const host = process.env.IRC_HOST?.trim();
  const nick = process.env.IRC_NICK?.trim();
  if (!host || !nick) return null;
  const portRaw = process.env.IRC_PORT?.trim();
  const tls = process.env.IRC_TLS?.trim().toLowerCase() !== 'false';
  const port = portRaw ? Number(portRaw) : tls ? 6697 : 6667;
  const password = process.env.IRC_PASSWORD?.trim() || undefined;
  const saslUser = process.env.IRC_SASL_USER?.trim();
  const saslPass = process.env.IRC_SASL_PASSWORD?.trim();
  const sasl = saslUser && saslPass ? { user: saslUser, password: saslPass } : undefined;
  const channels = parseIrcChannels(process.env.IRC_CHANNELS);
  return { host, port, tls, nick, password, channels, sasl };
}

export const ircPlugin: ChannelPlugin = {
  id: 'irc',
  label: 'IRC',
  description: 'IRC networks (Libera, OFTC, custom) over TLS.',
  docsPath: 'docs/channels/irc.md',
  envKeys: [
    'IRC_HOST',
    'IRC_PORT',
    'IRC_TLS',
    'IRC_NICK',
    'IRC_PASSWORD',
    'IRC_CHANNELS',
    'IRC_SASL_USER',
    'IRC_SASL_PASSWORD',
  ],
  status: 'stable',
  capabilities: { direction: 'bidirectional', inboundMedia: false, outboundMedia: false, proactive: true, editing: false, deletion: false },

  isConfigured(env = process.env) {
    return Boolean(env.IRC_HOST?.trim() && env.IRC_NICK?.trim());
  },

  isChatId(value: string) {
    return isIrcChatId(value);
  },

  async start(ctx: ChannelStartContext): Promise<ChannelRuntime | null> {
    const config = loadConfigFromEnv();
    if (!config) return null;
    try {
      const adapter = await createIrcAdapter(config, ctx.handler);
      return {
        async stop() {
          await adapter.stop();
        },
        async sendDirect(chatId, text) {
          if (!isIrcChatId(chatId)) return false;
          await sendDirectMessage(adapter.client, chatId, text);
          return true;
        },
      };
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Failed to start IRC adapter');
      return null;
    }
  },

  async runWizard({ prompts }: ChannelWizardContext): Promise<ChannelWizardResult | null> {
    prompts.log.info('IRC setup:');
    prompts.log.info('1. Pick a network (e.g. irc.libera.chat) and register your nick there if required.');
    prompts.log.info('2. For SASL auth, register at the network\'s NickServ and keep username/password handy.');
    prompts.log.info('3. MOZI connects over TLS by default (port 6697).');

    const host = await prompts.text({
      message: 'IRC server host:',
      placeholder: 'irc.libera.chat',
      validate: (v) => (!v?.trim() ? 'Host is required' : undefined),
    });
    if (prompts.isCancel(host)) return null;

    const tlsResp = await prompts.confirm({
      message: 'Use TLS? (recommended)',
      initialValue: true,
    });
    if (prompts.isCancel(tlsResp)) return null;
    const tls = Boolean(tlsResp);

    const portInput = await prompts.text({
      message: 'Port:',
      placeholder: tls ? '6697' : '6667',
      defaultValue: tls ? '6697' : '6667',
    });
    if (prompts.isCancel(portInput)) return null;
    const port = Number(String(portInput).trim());
    if (!Number.isFinite(port) || port <= 0) {
      prompts.log.warn('Port must be a positive integer; setup cancelled.');
      return null;
    }

    const nick = await prompts.text({
      message: 'Nick:',
      placeholder: 'mozi-bot',
      validate: (v) => (!v?.trim() ? 'Nick is required' : /\s/.test(v) ? 'No spaces allowed' : undefined),
    });
    if (prompts.isCancel(nick)) return null;

    const useSasl = await prompts.confirm({
      message: 'Does your nick use SASL (NickServ)?',
      initialValue: false,
    });
    if (prompts.isCancel(useSasl)) return null;

    let saslUser = '';
    let saslPass = '';
    if (useSasl) {
      const u = await prompts.text({ message: 'SASL username (usually same as nick):', defaultValue: String(nick) });
      if (prompts.isCancel(u)) return null;
      saslUser = String(u);
      const p = await prompts.password({ message: 'SASL password:' });
      if (prompts.isCancel(p)) return null;
      saslPass = String(p);
    }

    const channelsRaw = await prompts.text({
      message: 'Channels to auto-join (comma-separated):',
      placeholder: '#mozi-test,#another',
      defaultValue: '',
    });
    if (prompts.isCancel(channelsRaw)) return null;

    const config: IrcConfig = {
      host: String(host).trim(),
      port,
      tls,
      nick: String(nick).trim(),
      channels: parseIrcChannels(String(channelsRaw)),
      ...(useSasl ? { sasl: { user: saslUser, password: saslPass } } : {}),
    };

    const spinner = prompts.spinner();
    spinner.start(`Connecting to ${config.host}:${config.port}…`);
    const result = await validateConnection(config);
    if (!result.valid) {
      spinner.stop(`Connection failed: ${result.error ?? 'unknown'}. Not saved.`);
      return null;
    }
    spinner.stop(`Connected to ${config.host} as ${config.nick}.`);

    return {
      env: {
        IRC_HOST: config.host,
        IRC_PORT: String(config.port),
        IRC_TLS: String(config.tls),
        IRC_NICK: config.nick,
        IRC_CHANNELS: config.channels.join(','),
        ...(config.sasl ? { IRC_SASL_USER: config.sasl.user, IRC_SASL_PASSWORD: config.sasl.password } : {}),
      },
    };
  },
};
