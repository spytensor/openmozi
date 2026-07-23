import { WorkerAdapterRegistry } from './adapter.js';
import { ClaudeCodeWorkerAdapter } from './claude-code-adapter.js';
import { CodexCliWorkerAdapter } from './codex-cli-adapter.js';

const defaultWorkerAdapterRegistry = new WorkerAdapterRegistry([
  new ClaudeCodeWorkerAdapter(),
  new CodexCliWorkerAdapter(),
]);

export function getDefaultWorkerAdapterRegistry(): WorkerAdapterRegistry {
  return defaultWorkerAdapterRegistry;
}

export * from './adapter.js';
export * from './claude-code-adapter.js';
export * from './codex-cli-adapter.js';
export * from './dispatch.js';
export * from './job-state.js';
export * from './preflight.js';
export * from './transport.js';
