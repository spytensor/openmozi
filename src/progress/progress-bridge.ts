/**
 * Progress Bridge — subscribes to the event bus and renders
 * a live DAG progress message in Telegram.
 *
 * The bridge maintains a persistent message that gets edited
 * in real-time as tasks start, complete, or fail.
 */

import { on, type ProgressEvent } from './event-bus.js';
import { renderDagProgress, type DagTaskStatus } from './dag-renderer.js';
import { formatProgressText } from './progress-reporter.js';
import type { Telegraf } from 'telegraf';
import {
  sendMessage as tgSendMessage,
  editMessage as tgEditMessage,
} from '../channels/telegram.js';
import { saveTimelineItem } from '../memory/session-timeline.js';
import pino from 'pino';

const logger = pino({ name: 'mozi:progress-bridge' });

/** Telegram message text limit */
const TG_MAX_CHARS = 4000;

/** Debounce interval for Telegram edits (ms) */
const EDIT_DEBOUNCE_MS = 1_000;

export interface ProgressBridge {
  /** Start listening to the event bus */
  start(): void;
  /** Stop listening, flush pending edits, cancel timers */
  stop(): Promise<void>;
}

/**
 * Create a Telegram progress bridge that renders DAG events
 * as a single, continuously-edited message.
 */
export function createTelegramProgressBridge(
  bot: Telegraf,
  chatId: string,
): ProgressBridge {
  // Task state for DAG rendering
  const tasks = new Map<string, DagTaskStatus>();
  let taskOrder: string[] = [];

  // Extra status lines (agent events, budget warnings)
  const statusLines: string[] = [];
  let latestTurnState = '';
  let latestActivity = '';
  let latestWorkerStatus = '';
  let bridgeActive = false;

  // Telegram message tracking
  let messageId: number | null = null;
  let messagePending = false;

  // Debounce state
  let editTimer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribe: (() => void) | null = null;

  function activateBridge(): void {
    bridgeActive = true;
  }

  function resetBridgeState(): void {
    tasks.clear();
    taskOrder = [];
    statusLines.length = 0;
    latestTurnState = '';
    latestActivity = '';
    latestWorkerStatus = '';
    bridgeActive = false;
  }

  function pushStatusLine(line: string): void {
    if (!line.trim()) return;
    if (statusLines[statusLines.length - 1] === line) return;
    statusLines.push(line);
    if (statusLines.length > 6) {
      statusLines.splice(0, statusLines.length - 6);
    }
  }

  function persistGuardTimeline(event: ProgressEvent): void {
    if (!event.sessionId || !event.chatId || !event.taskId) return;
    saveTimelineItem({
      tenantId: event.tenantId,
      sessionId: event.sessionId,
      chatId: event.chatId,
      turnId: event.turnId,
      type: 'task_update',
      eventKey: `task:${event.taskId}`,
      timestamp: event.timestamp,
      preserveTimestampOnUpdate: true,
      mergeDataOnUpdate: true,
      data: {
        id: `task_${event.taskId}`,
        task_id: event.taskId,
        turnId: event.turnId,
        title: event.taskTitle,
        status: 'failed',
        guard_reason: event.reason,
        error_preview: event.errorPreview,
        timestamp: event.timestamp,
      },
    });
  }

  /** Build the full message text from current state */
  function buildMessage(): string {
    const taskList = taskOrder.map(id => tasks.get(id)!);
    const liveLines = [
      latestTurnState,
      latestActivity,
      latestWorkerStatus,
    ].filter((line) => line.trim().length > 0);
    const sections: string[] = [];

    if (taskList.length > 0) {
      sections.push(renderDagProgress(taskList));
      if (liveLines.length > 0) {
        sections.push(liveLines.join('\n'));
      }
    } else if (liveLines.length > 0) {
      sections.push(`Current turn:\n${liveLines.join('\n')}`);
    }

    if (statusLines.length > 0) {
      sections.push(statusLines.join('\n'));
    }

    let text = sections.join('\n\n').trim();

    // Truncate for Telegram limit
    if (text.length > TG_MAX_CHARS) {
      text = text.slice(0, TG_MAX_CHARS - 3) + '...';
    }

    return text;
  }

  /** Send or edit the message, debounced */
  function scheduleRender(): void {
    if (editTimer) return; // already scheduled

    editTimer = setTimeout(() => {
      editTimer = null;
      void flushRender();
    }, EDIT_DEBOUNCE_MS);
  }

  /** Actually send or edit the Telegram message */
  async function flushRender(): Promise<void> {
    const text = buildMessage();
    if (!bridgeActive || !text) return;

    if (messageId === null && !messagePending) {
      messagePending = true;
      try {
        messageId = await tgSendMessage(bot, chatId, text);
      } catch (err) {
        logger.warn({ err }, 'Failed to send progress message');
      } finally {
        messagePending = false;
      }
    } else if (messageId !== null) {
      try {
        await tgEditMessage(bot, chatId, messageId, text);
      } catch (err) {
        logger.debug({ err }, 'Failed to edit progress message');
      }
    }
  }

  /** Handle a single event from the bus */
  function handleEvent(event: ProgressEvent): void {
    // Filter: only handle events for this chat
    if (event.chatId && event.chatId !== chatId) return;

    switch (event.type) {
      case 'dag_created':
        activateBridge();
        tasks.clear();
        taskOrder = [];
        statusLines.length = 0;
        break;

      case 'task_started':
        if (event.taskId && event.taskTitle) {
          activateBridge();
          if (!tasks.has(event.taskId)) {
            taskOrder.push(event.taskId);
          }
          tasks.set(event.taskId, {
            title: event.taskTitle,
            status: 'running',
          });
          scheduleRender();
        }
        break;

      case 'task_completed':
        if (event.taskId && event.taskTitle) {
          activateBridge();
          if (!tasks.has(event.taskId)) {
            taskOrder.push(event.taskId);
          }
          tasks.set(event.taskId, {
            title: event.taskTitle,
            status: 'completed',
            elapsed_ms: event.elapsed_ms,
          });
          scheduleRender();
        }
        break;

      case 'task_failed':
      case 'task_cancelled':
      case 'task_guarded':
        if (event.taskId && event.taskTitle) {
          if (event.type === 'task_guarded') persistGuardTimeline(event);
          activateBridge();
          if (!tasks.has(event.taskId)) {
            taskOrder.push(event.taskId);
          }
          tasks.set(event.taskId, {
            title: event.taskTitle,
            status: 'failed',
          });
          scheduleRender();
        }
        break;

      case 'turn_state':
        latestTurnState = formatProgressText(event);
        if (bridgeActive) {
          scheduleRender();
        }
        break;

      case 'tool_call':
      case 'tool_result':
        latestActivity = formatProgressText(event);
        if (bridgeActive) {
          scheduleRender();
        }
        break;

      case 'worker_status':
        activateBridge();
        latestWorkerStatus = formatProgressText(event);
        scheduleRender();
        break;

      case 'agent_spawned':
      case 'agent_completed':
      case 'agent_failed':
        activateBridge();
        pushStatusLine(formatProgressText(event));
        scheduleRender();
        break;

      case 'budget_warning':
        if (!bridgeActive) break;
        pushStatusLine(formatProgressText(event));
        scheduleRender();
        break;

      case 'overall_progress':
        // Absorbed into DAG render — no-op
        break;

      case 'background_agent_complete':
        activateBridge();
        if (event.taskId) {
          if (!tasks.has(event.taskId)) taskOrder.push(event.taskId);
          tasks.set(event.taskId, {
            title: event.taskTitle || 'Background task',
            status: 'completed',
            elapsed_ms: event.elapsed_ms,
          });
        }
        pushStatusLine(`✅ Background agent completed: ${event.taskTitle || event.taskId || 'unknown'}`);
        scheduleRender();
        break;

      case 'background_agent_failed':
        activateBridge();
        if (event.taskId) {
          if (!tasks.has(event.taskId)) taskOrder.push(event.taskId);
          tasks.set(event.taskId, {
            title: event.taskTitle || 'Background task',
            status: 'failed',
          });
        }
        pushStatusLine(`❌ Background agent failed: ${event.error || event.taskTitle || 'unknown'}`);
        scheduleRender();
        break;

      default:
        break;
    }
  }

  return {
    start() {
      unsubscribe = on(handleEvent);
    },

    async stop() {
      unsubscribe?.();
      unsubscribe = null;
      if (editTimer) {
        clearTimeout(editTimer);
        editTimer = null;
      }
      resetBridgeState();
    },
  };
}
