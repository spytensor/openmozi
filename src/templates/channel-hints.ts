/**
 * Channel-specific prompt hints injected into SOUL.md at runtime.
 */

export const CHANNEL_HINTS: Record<string, string> = {
  telegram: `You are responding via Telegram. Keep messages under 4000 chars. Use plain text only — no markdown tables, no code fences. Use bullet points (•), numbered lists, and simple formatting. Response time matters — prefer concise answers.`,

  websocket: `You are responding via the Web UI. Rich markdown is supported — use tables, code blocks, headers, bold, links as appropriate. Streaming is enabled — responses appear in real-time. You can send artifacts (code files, documents) as structured objects.`,

  voice: `You are in voice mode. Keep responses brief and conversational. Avoid code blocks and complex formatting — this will be read aloud. Prefer short, direct sentences.`,
};

export function getChannelHint(channelType?: string): string {
  if (!channelType) return '';
  return CHANNEL_HINTS[channelType] ?? '';
}
