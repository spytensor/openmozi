export function buildTenantScopedChatKey(chatId: string, tenantId: string): string {
  return `${tenantId}:${chatId}`;
}
