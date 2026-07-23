/**
 * Built-in tool plugin hooks. Registered once at startup from `src/index.ts`,
 * mirroring the `installBuiltinChannelPlugins()` pattern.
 *
 * These hooks ship enabled by default because they are "only safer" — they
 * strip credentials / inject warnings but never grant access. A future
 * opt-out via config can be added if any rule produces a false positive
 * in real workloads.
 */
import { registerToolHook } from '../plugin-registry.js';
import { redactSecretsHook } from './redact-secrets.js';

export function installBuiltinToolHooks(): void {
  registerToolHook(redactSecretsHook);
}
