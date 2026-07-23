import type { TaskHandler } from '../registry.js';

/** Deterministic scheduled notification; no shell or model execution. */
export const notifyHandler: TaskHandler = async (task) => {
  const params = task.handler_params ? JSON.parse(task.handler_params) as Record<string, unknown> : {};
  const message = typeof params.message === 'string' ? params.message.trim() : '';
  return message || task.objective;
};
