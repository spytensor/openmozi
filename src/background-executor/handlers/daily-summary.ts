/**
 * Daily Summary Handler — Generate project/activity summary.
 *
 * handler_params: { scope?: 'project' | 'activity' | 'all' }
 */

import type { BackgroundTask } from '../../core/background-tasks.js';
import { getBrainClient } from '../../core/model-router.js';
import { getHistory } from '../../memory/conversations.js';
import { listSessions } from '../../memory/sessions.js';

export async function dailySummaryHandler(task: BackgroundTask, signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw new Error('Task aborted');

  const params = task.handler_params ? JSON.parse(task.handler_params) : {};
  const scope = params.scope ?? 'all';

  // Collect data for summary
  const sections: string[] = [];

  // Recent sessions
  try {
    const sessions = listSessions(task.chat_id, { tenantId: task.tenant_id, limit: 10 });
    if (sessions.length > 0) {
      sections.push(`Recent sessions (last ${sessions.length}):\n${sessions.map(s => `- ${s.title} (${s.updated_at})`).join('\n')}`);
    }
  } catch { /* DB may not have sessions */ }

  // Recent conversation highlights
  try {
    const history = getHistory(task.chat_id, 20, task.tenant_id);
    if (history.length > 0) {
      const userMessages = history
        .filter(m => m.role === 'user')
        .map(m => typeof m.content === 'string' ? m.content.slice(0, 100) : '')
        .filter(Boolean);
      if (userMessages.length > 0) {
        sections.push(`Recent topics:\n${userMessages.map(m => `- ${m}`).join('\n')}`);
      }
    }
  } catch { /* ignore */ }

  if (sections.length === 0) {
    return 'No recent activity to summarize.';
  }

  // Use LLM to generate summary
  const tenantId = task.tenant_id;
  const { client } = getBrainClient({ tenantId });
  const prompt = `Generate a concise daily summary based on the following activity data. Use bullet points. Keep it under 300 words.\n\n${sections.join('\n\n')}`;

  const response = await client.chat(
    [
      { role: 'system', content: 'You are a concise daily briefing generator. Summarize the key points from the activity data. Use the same language as the activity data.' },
      { role: 'user', content: prompt },
    ],
    {
      max_tokens: 500,
      temperature: 0.3,
      abort_signal: signal,
      billing: { tenantId, taskId: String(task.id) },
    },
  );

  return response.content;
}
