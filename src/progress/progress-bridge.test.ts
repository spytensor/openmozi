import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { emit, removeAllListeners } from './event-bus.js';
import { createTelegramProgressBridge } from './progress-bridge.js';

// ---------------------------------------------------------------------------
// Mock Telegram bot
// ---------------------------------------------------------------------------

function createMockBot() {
  const sentMessages: { chatId: string; text: string }[] = [];
  const editedMessages: { chatId: string; messageId: number; text: string }[] = [];
  let nextMessageId = 100;

  const bot = {
    telegram: {
      sendMessage: vi.fn(async (chatId: string, text: string) => {
        sentMessages.push({ chatId, text });
        return { message_id: nextMessageId++ };
      }),
      editMessageText: vi.fn(async (chatId: string, messageId: number, _inlineId: undefined, text: string) => {
        editedMessages.push({ chatId, messageId, text });
        return {};
      }),
    },
  } as any;

  return { bot, sentMessages, editedMessages };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('progress/progress-bridge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    removeAllListeners();
    vi.useRealTimers();
  });

  it('filters events by chatId', async () => {
    const { bot, sentMessages } = createMockBot();
    const bridge = createTelegramProgressBridge(bot, 'chat-1');
    bridge.start();

    // Event for a different chat
    emit({ type: 'task_started', taskId: 't1', taskTitle: 'Other', chatId: 'chat-2' });

    await vi.advanceTimersByTimeAsync(1100);

    expect(sentMessages).toHaveLength(0);

    await bridge.stop();
  });

  it('shows completed task with elapsed time', async () => {
    const { bot, sentMessages } = createMockBot();
    const bridge = createTelegramProgressBridge(bot, 'chat-1');
    bridge.start();

    emit({ type: 'task_started', taskId: 't1', taskTitle: 'Build', chatId: 'chat-1' });
    emit({ type: 'task_completed', taskId: 't1', taskTitle: 'Build', elapsed_ms: 1800, chatId: 'chat-1' });

    await vi.advanceTimersByTimeAsync(1100);

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].text).toContain('[x] Build');
    expect(sentMessages[0].text).toContain('1.8s');

    await bridge.stop();
  });

  it('shows failed task with [!] indicator', async () => {
    const { bot, sentMessages } = createMockBot();
    const bridge = createTelegramProgressBridge(bot, 'chat-1');
    bridge.start();

    emit({ type: 'task_started', taskId: 't1', taskTitle: 'Deploy', chatId: 'chat-1' });
    emit({ type: 'task_failed', taskId: 't1', taskTitle: 'Deploy', error: 'timeout', chatId: 'chat-1' });

    await vi.advanceTimersByTimeAsync(1100);

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].text).toContain('[!] Deploy');

    await bridge.stop();
  });

  it('appends agent events as status lines', async () => {
    const { bot, sentMessages } = createMockBot();
    const bridge = createTelegramProgressBridge(bot, 'chat-1');
    bridge.start();

    emit({ type: 'task_started', taskId: 't1', taskTitle: 'Code', chatId: 'chat-1' });
    emit({ type: 'agent_spawned', agentId: 'a1', agentRole: 'coder', chatId: 'chat-1' });

    await vi.advanceTimersByTimeAsync(1100);

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].text).toContain('Agent spawned: coder');

    await bridge.stop();
  });

  it('appends budget_warning as status line', async () => {
    const { bot, sentMessages } = createMockBot();
    const bridge = createTelegramProgressBridge(bot, 'chat-1');
    bridge.start();

    emit({ type: 'task_started', taskId: 't1', taskTitle: 'Work', chatId: 'chat-1' });
    emit({ type: 'budget_warning', level: 'soft', usagePercent: 72, chatId: 'chat-1' });

    await vi.advanceTimersByTimeAsync(1100);

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].text).toContain('Token budget: soft (72%)');

    await bridge.stop();
  });

  it('debounces rapid events into a single edit', async () => {
    const { bot, sentMessages, editedMessages } = createMockBot();
    const bridge = createTelegramProgressBridge(bot, 'chat-1');
    bridge.start();

    emit({ type: 'task_started', taskId: 't1', taskTitle: 'A', chatId: 'chat-1' });
    await vi.advanceTimersByTimeAsync(1100);
    expect(sentMessages).toHaveLength(1);

    // Fire multiple events rapidly
    emit({ type: 'task_completed', taskId: 't1', taskTitle: 'A', elapsed_ms: 100, chatId: 'chat-1' });
    emit({ type: 'task_started', taskId: 't2', taskTitle: 'B', chatId: 'chat-1' });
    emit({ type: 'task_completed', taskId: 't2', taskTitle: 'B', elapsed_ms: 200, chatId: 'chat-1' });

    await vi.advanceTimersByTimeAsync(1100);

    // Should coalesce into a single edit
    expect(editedMessages).toHaveLength(1);

    await bridge.stop();
  });

  it('stop() clears timers and unsubscribes', async () => {
    const { bot, sentMessages } = createMockBot();
    const bridge = createTelegramProgressBridge(bot, 'chat-1');
    bridge.start();

    await bridge.stop();

    emit({ type: 'task_started', taskId: 't1', taskTitle: 'After stop', chatId: 'chat-1' });
    await vi.advanceTimersByTimeAsync(1100);

    expect(sentMessages).toHaveLength(0);
  });

  it('ignores overall_progress events', async () => {
    const { bot, sentMessages } = createMockBot();
    const bridge = createTelegramProgressBridge(bot, 'chat-1');
    bridge.start();

    emit({ type: 'overall_progress', totalTasks: 3, completedTasks: 1, chatId: 'chat-1' });

    await vi.advanceTimersByTimeAsync(1100);

    // No task data, so nothing to render
    expect(sentMessages).toHaveLength(0);

    await bridge.stop();
  });

  it('accepts events without chatId (unfiltered)', async () => {
    const { bot, sentMessages } = createMockBot();
    const bridge = createTelegramProgressBridge(bot, 'chat-1');
    bridge.start();

    // Events without chatId should pass through (backwards compatibility)
    emit({ type: 'task_started', taskId: 't1', taskTitle: 'Legacy' });

    await vi.advanceTimersByTimeAsync(1100);

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].text).toContain('Legacy');

    await bridge.stop();
  });

  it('does not create a Telegram progress message for turn_state alone', async () => {
    const { bot, sentMessages } = createMockBot();
    const bridge = createTelegramProgressBridge(bot, 'chat-1');
    bridge.start();

    emit({ type: 'turn_state', turnState: 'EXECUTING', detail: 'brain execution', chatId: 'chat-1' });
    await vi.advanceTimersByTimeAsync(1100);

    expect(sentMessages).toHaveLength(0);

    await bridge.stop();
  });

  it('renders stored turn/tool lines once a managed worker activates progress', async () => {
    const { bot, sentMessages, editedMessages } = createMockBot();
    const bridge = createTelegramProgressBridge(bot, 'chat-1');
    bridge.start();

    emit({ type: 'turn_state', turnState: 'EXECUTING', detail: 'brain execution', chatId: 'chat-1' });
    emit({ type: 'tool_call', toolName: 'shell_exec_bg', intent: 'Launch coding agent: Refactor gateway', chatId: 'chat-1' });
    emit({
      type: 'worker_status',
      runtimeLabel: 'Claude Code',
      adapterId: 'claude_code',
      workerStatus: 'running',
      lane: 'code',
      sandboxProfile: 'adapter-managed',
      chatId: 'chat-1',
    });

    await vi.advanceTimersByTimeAsync(1100);

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].text).toContain('Current turn:');
    expect(sentMessages[0].text).toContain('Phase: executing - brain execution');
    expect(sentMessages[0].text).toContain('Action: Launch coding agent: Refactor gateway');
    expect(sentMessages[0].text).toContain('Claude Code: running');

    emit({
      type: 'worker_status',
      runtimeLabel: 'Claude Code',
      adapterId: 'claude_code',
      workerStatus: 'running',
      heartbeat: true,
      elapsed_ms: 65_000,
      chatId: 'chat-1',
    });

    await vi.advanceTimersByTimeAsync(1100);

    expect(editedMessages).toHaveLength(1);
    expect(editedMessages[0].text).toContain('still running (1m5s)');

    await bridge.stop();
  });
});
