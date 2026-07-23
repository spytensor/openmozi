export const MAX_CLI_SPAWN_ENTRY_BYTES = 131_072;
export const MAX_CLI_SPAWN_TOTAL_BYTES = 983_040;

export type CliSpawnBudgetDetails = {
  kind: 'argv' | 'env' | 'total';
  index?: number;
  key?: string;
  bytes: number;
  limit: number;
};

export class CliSpawnBudgetError extends Error {
  readonly details: CliSpawnBudgetDetails;

  constructor(details: CliSpawnBudgetDetails) {
    const entry = details.kind === 'argv'
      ? `argv[${details.index}]`
      : details.kind === 'env'
        ? `environment entry ${details.key}`
        : 'argv and environment total';
    super(`CLI spawn budget exceeded for ${entry}: ${details.bytes} bytes > ${details.limit} bytes`);
    this.name = 'CliSpawnBudgetError';
    this.details = details;
  }
}

function nulTerminatedBytes(value: string): number {
  return Buffer.byteLength(value, 'utf8') + 1;
}

export function assertCliSpawnBudget(
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): void {
  let totalBytes = 0;
  const argv = [command, ...args];
  for (let index = 0; index < argv.length; index += 1) {
    const bytes = nulTerminatedBytes(argv[index]);
    if (bytes > MAX_CLI_SPAWN_ENTRY_BYTES) {
      throw new CliSpawnBudgetError({
        kind: 'argv', index, bytes, limit: MAX_CLI_SPAWN_ENTRY_BYTES,
      });
    }
    totalBytes += bytes;
  }

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const bytes = nulTerminatedBytes(`${key}=${value}`);
    if (bytes > MAX_CLI_SPAWN_ENTRY_BYTES) {
      throw new CliSpawnBudgetError({
        kind: 'env', key, bytes, limit: MAX_CLI_SPAWN_ENTRY_BYTES,
      });
    }
    totalBytes += bytes;
  }

  if (totalBytes > MAX_CLI_SPAWN_TOTAL_BYTES) {
    throw new CliSpawnBudgetError({
      kind: 'total', bytes: totalBytes, limit: MAX_CLI_SPAWN_TOTAL_BYTES,
    });
  }
}
