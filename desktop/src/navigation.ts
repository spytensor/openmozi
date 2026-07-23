export async function prepareRuntimeAfterStatus<T>(
  loadStatus: () => Promise<void>,
  ensureReady: () => Promise<T>,
): Promise<T> {
  await loadStatus();
  return ensureReady();
}
