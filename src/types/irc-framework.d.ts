declare module 'irc-framework' {
  export interface ClientOptions {
    host: string;
    port: number;
    tls: boolean;
    nick: string;
    password?: string;
    sasl?: {
      account: string;
      password: string;
    };
  }

  export interface MessageEvent {
    nick: string;
    ident?: string;
    hostname?: string;
    target: string;
    message: string;
    type?: string;
    tags?: Record<string, string>;
  }

  export class Client {
    user?: { nick?: string };
    connect(options: ClientOptions): void;
    quit(message?: string): void;
    join(channel: string): void;
    say(target: string, message: string): void;
    on(event: 'registered' | 'socket close', handler: () => void): void;
    on(event: 'error', handler: (err: Error) => void): void;
    on(event: 'message', handler: (event: MessageEvent) => void | Promise<void>): void;
    on(event: string, handler: (...args: unknown[]) => void): void;
  }

  const IrcFramework: {
    Client: typeof Client;
  };
  export default IrcFramework;
}
