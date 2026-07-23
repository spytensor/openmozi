import type { Writable } from 'node:stream';
import type { CliBackendConfig } from './providers.js';

export type CliPromptDelivery = {
  mode: 'arg' | 'stdin';
  promptArgs: string[];
  stdinPayload?: string;
};

type PromptDeliveryConfig = Pick<
  CliBackendConfig,
  'input' | 'maxPromptArgBytes' | 'promptArg' | 'stdinPromptArgs'
>;

export class CliPromptDeliveryError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    const code = cause && typeof cause === 'object' && 'code' in cause
      ? String((cause as { code?: unknown }).code ?? 'unknown')
      : 'unknown';
    super(`CLI prompt delivery failed on stdin (${code})`);
    this.name = 'CliPromptDeliveryError';
    this.cause = cause;
  }
}

export function resolveCliPromptDelivery(
  prompt: string,
  backend: PromptDeliveryConfig,
): CliPromptDelivery {
  const useStdin = backend.input === 'stdin'
    || (backend.maxPromptArgBytes !== undefined
      && Buffer.byteLength(prompt, 'utf8') >= backend.maxPromptArgBytes);

  if (useStdin) {
    return {
      mode: 'stdin',
      promptArgs: [...(backend.stdinPromptArgs ?? [])],
      stdinPayload: prompt,
    };
  }

  return {
    mode: 'arg',
    promptArgs: backend.promptArg ? [backend.promptArg, prompt] : [prompt],
  };
}

export function writeCliPromptToStdin(
  stdin: Writable,
  payload: string,
  onError: (error: CliPromptDeliveryError) => void,
): void {
  stdin.once('error', error => onError(new CliPromptDeliveryError(error)));
  try {
    stdin.end(payload);
  } catch (error) {
    onError(new CliPromptDeliveryError(error));
  }
}
