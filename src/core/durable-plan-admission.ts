import type { ChatMessage } from './llm.js';
import { buildRuntimeInterjection } from './runtime-interjection.js';
import { requiresDurablePlan } from './complexity-hint.js';

export type RuntimeAdmission = 'durable_plan' | 'plan_control' | 'scheduler_control';

export const DURABLE_PLAN_POLICY = '[Runtime policy] This request requires durable plan execution. Activate any relevant workflow skill, then call decompose_task to create the persisted dependency graph. The runtime will reject inline work and direct final delivery until the plan is accepted.';

export const SCHEDULER_CONTROL_POLICY = '[Runtime policy] This turn controls a MOZI-managed schedule. Create, inspect, or cancel the schedule through the exposed scheduler tools only. Do not execute the scheduled workload now, do not create a durable plan for it now, and never use shell or host schedulers such as crontab or launchd.';

const DURABLE_PLAN_REJECTION = '[Runtime admission rejected] Direct execution and final delivery are not allowed for this request. Call decompose_task now. Do not search, write files, run commands, or claim results in this foreground turn.';
const MAX_DURABLE_PLAN_REJECTIONS = 2;

export interface DurablePlanAdmissionState {
  rejections: number;
  lastValidationError?: string;
}

const CURRENT_PLAN_REFERENCE = /\b(?:current|existing|running|that|this|the)\s+(?:plan|task)|\bplan\s+(?:id|status|progress)\b|当前(?:计划|任务)|现有(?:计划|任务)|这个计划|该计划/i;
const PLAN_CONTROL_ACTION = /\b(?:continue|resume|retry|repair|rerun|restart|cancel|stop|pause|inspect|check|show|update)\b|继续|恢复|重试|修复|重新运行|重启|取消|停止|暂停|检查|查看|显示|更新/i;
const SCHEDULER_TARGET = /\b(?:cron|scheduled?\s+(?:task|job)|recurring\s+(?:task|job)|reminder)\b|定时任务|计划任务|定时提醒|提醒(?:我|事项)?/i;
const SCHEDULER_ACTION = /\b(?:create|add|set(?:\s+up)?|schedule|cancel|delete|remove|stop|pause|resume|list|show|inspect|update|modify)\b|创建|构建|新增|设置|安排|取消|删除|停止|暂停|恢复|列出|查看|显示|更新|修改/i;
const RECURRING_WORK_REQUEST = /(?:每天|每日|每周|每月|每个工作日|到点|定时|自动).{0,80}(?:执行|运行|跑|生成|整理|发送|推送|通知|提醒)|\b(?:daily|weekly|monthly|every\s+(?:day|week|month|weekday)).{0,80}\b(?:run|execute|generate|send|notify|remind)\b/i;

export type SchedulerControlAction = 'create' | 'cancel' | 'list' | 'update';

export function resolveSchedulerControlAction(userText: string): SchedulerControlAction {
  if (/\b(?:cancel|delete|remove|stop)\b|取消|删除|停止/i.test(userText)) return 'cancel';
  if (/\b(?:list|show|inspect|check)\b|列出|查看|显示|检查/i.test(userText)) return 'list';
  if (/\b(?:update|modify|pause|resume)\b|更新|修改|暂停|恢复/i.test(userText)) return 'update';
  return 'create';
}

export function isSchedulerControlRequest(userText: string): boolean {
  return (SCHEDULER_TARGET.test(userText) && SCHEDULER_ACTION.test(userText))
    || RECURRING_WORK_REQUEST.test(userText);
}

export function schedulerAdmissionToolNames(userText: string): Set<string> {
  const action = resolveSchedulerControlAction(userText);
  const reminderOnly = /\breminder\b|提醒(?:我|事项)?/i.test(userText)
    && !/\b(?:cron|scheduled?\s+(?:task|job)|recurring\s+(?:task|job))\b|定时任务|计划任务/i.test(userText);
  const families = reminderOnly
    ? { set: 'set_reminder', list: 'list_reminders', cancel: 'cancel_reminder' }
    : { set: 'set_cron_task', list: 'list_cron_tasks', cancel: 'cancel_cron_task' };
  if (action === 'create') return new Set([families.set]);
  if (action === 'list') return new Set([families.list]);
  if (action === 'cancel') return new Set([families.list, families.cancel]);
  return new Set([families.list, families.cancel, families.set]);
}

export function schedulerTerminalToolNames(userText: string): Set<string> {
  const action = resolveSchedulerControlAction(userText);
  const admitted = schedulerAdmissionToolNames(userText);
  if (action === 'cancel') return new Set([...admitted].filter(name => name.startsWith('cancel_')));
  if (action === 'list') return new Set([...admitted].filter(name => name.startsWith('list_')));
  if (action === 'create') return new Set([...admitted].filter(name => name.startsWith('set_')));
  return new Set([...admitted].filter(name => name.startsWith('set_') || name.startsWith('cancel_')));
}

export function resolveRuntimeAdmission(
  userText: string,
  options: { hasNonTerminalPlan?: boolean } = {},
): RuntimeAdmission | undefined {
  // Control-plane intent outranks workload complexity. A request such as
  // "schedule a daily research dashboard" defines future work; it must not
  // execute that research in the foreground merely because the payload is
  // complex enough to need a DAG when the schedule eventually fires.
  if (isSchedulerControlRequest(userText)) return 'scheduler_control';
  if (
    options.hasNonTerminalPlan &&
    CURRENT_PLAN_REFERENCE.test(userText) &&
    PLAN_CONTROL_ACTION.test(userText)
  ) {
    return 'plan_control';
  }
  return requiresDurablePlan(userText) ? 'durable_plan' : undefined;
}

export function createDurablePlanAdmissionState(): DurablePlanAdmissionState {
  return { rejections: 0 };
}

export function rejectDurablePlanCompletion(
  state: DurablePlanAdmissionState,
  loopMessages: ChatMessage[],
  candidateText: string,
): { blocked: boolean; rejection: number } {
  if (state.rejections >= MAX_DURABLE_PLAN_REJECTIONS) {
    return { blocked: true, rejection: state.rejections };
  }
  state.rejections += 1;
  if (candidateText.trim()) loopMessages.push({ role: 'assistant', content: candidateText });
  const validationContext = state.lastValidationError
    ? `\n\nMost recent decompose_task validation error:\n${state.lastValidationError}`
    : '';
  loopMessages.push(buildRuntimeInterjection(
    'kernel_directive',
    `${DURABLE_PLAN_REJECTION}${validationContext}`,
  ));
  return { blocked: false, rejection: state.rejections };
}

export function durablePlanBlockedResponse(userText: string): string {
  if (/[㐀-鿿]/.test(userText)) {
    return 'MOZI 未能建立此任务所要求的持久化计划，因此运行时已阻止内联执行。当前没有计划启动，也没有结果可交付，请重试。';
  }
  return 'MOZI could not create the required durable plan, so the runtime blocked inline execution. No plan was started and no result is being claimed. Please retry.';
}
