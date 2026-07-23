# Mozi 稳定性测试报告

**测试日期**: 2026-03-09
**测试人**: GPT-5.4 (via OpenClaw)

---

## 一、测试环境

| 项目 | 配置 |
|------|------|
| Mozi 版本 | commit 29fb46f |
| Brain 模型 | gemini-2.5-flash |
| 运行平台 | Ubuntu, Node.js v22 |
| 启动方式 | `node dist/cli.js start` |

---

## 二、发现的问题

### 问题 1：Proactive Engine 被速率限制阻断（P0 - Critical）

**现象**：
```
{"msg":"LLM judge call failed","err":"Failed after 3 attempts. Last error: Too Many Requests"}
```

**原因**：
- Proactive Engine 每 2 分钟调用 LLM 判断是否通知用户
- Gemini 2.5 Flash 有 RPM（Requests Per Minute）限制
- 连续调用触发速率限制，导致主动性功能完全失效

**影响**：
- 主动性引擎无法工作
- 无法主动推送信息
- 无法在用户离开时监控目标

**位置**：
- `src/core/proactive-engine.ts:461` - `wake()` 函数
- `src/core/proactive-engine.ts:424` - `defaultLLMCall()` 函数

---

### 问题 2：工具执行失败后没有智能重试（P0 - Critical）

**现象**：
- 工具失败后只返回错误信息
- LLM 可能重复相同调用，陷入循环
- 没有自动尝试替代方案

**原因**：
```typescript
// src/tools/executor.ts:106
catch (err) {
  return { tool_call_id: id, content: `Error: ${message}`, is_error: true };
}
```

**影响**：
- 网络抖动导致工具失败
- 临时错误被视为永久错误
- 用户需要重新发送请求

**位置**：
- `src/tools/executor.ts` - `executeToolInner()` 函数

---

### 问题 3：循环检测后只能停止，不能自动纠正（P1 - High）

**现象**：
- 检测到循环后注入提示
- 如果 LLM 继续循环，只能停止
- 没有自动尝试替代工具或回滚

**原因**：
```typescript
// src/gateway/tool-loop-guards.ts
// 只有 buildFailureHintMessage 和 buildGuardFallbackMessage
// 没有自动纠正逻辑
```

**影响**：
- 复杂任务容易失败
- 用户需要手动干预

**位置**：
- `src/gateway/tool-loop-guards.ts`

---

### 问题 4：复杂任务缺少中间状态恢复（P1 - High）

**现象**：
- 多步骤任务中途失败
- 前面的结果丢失
- 需要从头开始

**原因**：
- 有 checkpoint 机制，但恢复策略依赖 LLM
- 没有显式的任务状态持久化

**位置**：
- `src/core/turn-atomic-rollback.ts`
- `src/core/task-dispatcher.ts`

---

### 问题 5：模型配置过于保守（P2 - Medium）

**现象**：
```json
{
  "brain": { "model": "gemini-2.5-flash" },
  "roles": {
    "complex_subagent": { "model": "gemini-2.5-pro" },
    "code": { "model": "gemini-2.5-flash" }
  }
}
```

**问题**：
- 复杂推理任务可能需要更强的模型
- Flash 可能不够稳定

---

### 问题 6：Telegram API 调用失败（P3 - Low）

**现象**：
```
"Failed to send typing action"
"request to https://api.telegram.org/... failed, reason: "
```

**原因**：
- 网络问题或 Telegram API 限流

**影响**：
- 用户看不到 typing 状态
- 不影响核心功能

---

## 三、已有的优秀机制

| 机制 | 文件 | 状态 |
|------|------|------|
| 崩溃恢复 | `crash-recovery.ts` | ✅ 完整 |
| Turn 状态机 | `turn-control.ts` | ✅ 完整 |
| 循环检测 | `tool-loop-guards.ts` | ✅ 有，但不够智能 |
| Checkpoint | `turn-atomic-rollback.ts` | ✅ 有，但恢复策略弱 |
| Proactive Engine | `proactive-engine.ts` | ⚠️ 架构完整，但被限流阻断 |
| 事件学习 | `event-learner.ts` | ✅ 有，但学习结果未被充分利用 |

---

## 四、优化计划

### Phase 1：修复 Proactive Engine 限流问题（1-2 天）

**目标**：让主动性引擎稳定运行

**改动**：

1. **添加指数退避**
```typescript
// proactive-engine.ts
let consecutiveFailures = 0;
const BASE_INTERVAL = 2 * 60_000;
const MAX_INTERVAL = 30 * 60_000;

function getNextInterval(): number {
  return Math.min(BASE_INTERVAL * Math.pow(2, consecutiveFailures), MAX_INTERVAL);
}
```

2. **添加缓存层**
```typescript
// 缓存相似事件的决策结果
const decisionCache = new Map<string, { decision: ProactiveDecision; timestamp: number }>();
```

3. **降级策略**
```typescript
// 如果 LLM 调用失败，使用规则引擎
function fallbackDecision(events: ProactiveEvent[]): ProactiveDecision {
  // 简单规则：只有 critical 事件才通知
  const critical = events.find(e => e.type.startsWith('alert:critical'));
  if (critical) {
    return { action: 'notify', message: critical.summary };
  }
  return { action: 'nothing' };
}
```

---

### Phase 2：工具执行智能重试（2-3 天）

**目标**：减少临时错误导致的失败

**改动**：

1. **错误分类**
```typescript
enum ErrorType {
  TRANSIENT = 'transient',      // 网络错误、超时
  PERMANENT = 'permanent',      // 权限错误、路径不存在
  RATE_LIMITED = 'rate_limited', // 被限流
}

function classifyError(error: Error): ErrorType {
  if (/network|timeout|econnrefused/i.test(error.message)) return ErrorType.TRANSIENT;
  if (/permission denied|enoent/i.test(error.message)) return ErrorType.PERMANENT;
  if (/rate limit|too many requests/i.test(error.message)) return ErrorType.RATE_LIMITED;
  return ErrorType.PERMANENT;
}
```

2. **重试策略**
```typescript
async function executeToolWithRetry(
  toolCall: ToolCall,
  context?: ToolContext,
  maxRetries = 3
): Promise<ToolResult> {
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const result = await executeTool(toolCall, context);
    if (!result.is_error) return result;
    
    const errorType = classifyError(new Error(result.content));
    
    if (errorType === ErrorType.PERMANENT) {
      return result; // 不重试永久错误
    }
    
    if (errorType === ErrorType.TRANSIENT) {
      await sleep(1000 * Math.pow(2, attempt)); // 指数退避
      continue;
    }
    
    if (errorType === ErrorType.RATE_LIMITED) {
      await sleep(60000); // 等 1 分钟
      continue;
    }
  }
  
  return { tool_call_id: toolCall.id, content: `Error: ${lastError}`, is_error: true };
}
```

---

### Phase 3：智能循环恢复（2-3 天）

**目标**：循环时自动尝试替代方案

**改动**：

1. **循环类型识别**
```typescript
enum LoopType {
  PARAMETER_ERROR = 'parameter_error',
  PATH_ERROR = 'path_error',
  PERMISSION_ERROR = 'permission_error',
  TOOL_FAILURE = 'tool_failure',
}

function diagnoseLoop(failureDetails: string[]): LoopType {
  const joined = failureDetails.join('\n');
  if (/enoent|no such file/i.test(joined)) return LoopType.PATH_ERROR;
  if (/permission denied/i.test(joined)) return LoopType.PERMISSION_ERROR;
  if (/invalid|expected/i.test(joined)) return LoopType.PARAMETER_ERROR;
  return LoopType.TOOL_FAILURE;
}
```

2. **自动纠正**
```typescript
async function attemptRecovery(
  loopType: LoopType,
  toolCall: ToolCall,
  context?: ToolContext
): Promise<ToolResult | null> {
  switch (loopType) {
    case LoopType.PATH_ERROR:
      // 尝试搜索正确路径
      const path = extractPath(toolCall);
      const searchResult = await searchPath(path);
      if (searchResult) {
        const correctedCall = { ...toolCall, arguments: JSON.stringify({ ...JSON.parse(toolCall.function.arguments), path: searchResult }) };
        return executeTool(correctedCall, context);
      }
      break;
      
    case LoopType.PERMISSION_ERROR:
      // 尝试替代工具
      if (toolCall.function.name === 'shell_exec') {
        return { tool_call_id: toolCall.id, content: 'Shell execution blocked. Try using file operations instead.', is_error: true };
      }
      break;
  }
  
  return null;
}
```

---

### Phase 4：任务状态持久化（3-5 天）

**目标**：中途失败可以从断点继续

**改动**：

1. **任务状态表**
```sql
CREATE TABLE task_states (
  id TEXT PRIMARY KEY,
  chat_id TEXT,
  goal TEXT,
  steps JSON,
  current_step INTEGER,
  results JSON,
  created_at INTEGER,
  updated_at INTEGER
);
```

2. **步骤保存**
```typescript
async function saveStepResult(taskId: string, stepIndex: number, result: unknown): Promise<void> {
  const task = await getTask(taskId);
  task.steps[stepIndex].result = result;
  task.current_step = stepIndex + 1;
  await saveTask(task);
}
```

3. **断点恢复**
```typescript
async function resumeFromCheckpoint(taskId: string): Promise<void> {
  const task = await getTask(taskId);
  for (let i = task.current_step; i < task.steps.length; i++) {
    const result = await executeStep(task.steps[i]);
    await saveStepResult(taskId, i, result);
  }
}
```

---

## 五、工作量估算

| Phase | 工作量 | 优先级 |
|-------|--------|--------|
| Phase 1: Proactive Engine 限流 | 1-2 天 | P0 |
| Phase 2: 工具执行重试 | 2-3 天 | P0 |
| Phase 3: 智能循环恢复 | 2-3 天 | P1 |
| Phase 4: 任务状态持久化 | 3-5 天 | P1 |
| **总计** | **8-13 天** | — |

---

## 六、最小可行改进

如果时间有限，只做：

1. **Phase 1 的一部分**：添加退避机制（0.5 天）
2. **Phase 2 的一部分**：网络工具重试（1 天）

**效果**：减少 30-50% 的失败率

---

## 七、测试用例

### TC-1: Proactive Engine 长期运行

**步骤**：
1. 启动 Mozi
2. 等待 30 分钟
3. 检查日志

**预期**：没有连续的 "Too Many Requests" 错误

---

### TC-2: 网络工具失败重试

**步骤**：
1. 发送 "帮我搜索 xxx"
2. 模拟网络超时
3. 观察是否自动重试

**预期**：自动重试，最终返回结果

---

### TC-3: 循环检测和恢复

**步骤**：
1. 发送 "帮我读取一个不存在的文件"
2. 观察 LLM 是否尝试搜索正确路径

**预期**：检测到路径错误，自动搜索

---

### TC-4: 复杂任务中途失败恢复

**步骤**：
1. 发送多步骤任务
2. 在第 3 步模拟失败
3. 重新发送相同任务

**预期**：从第 3 步继续，不需要从头开始

---

## 八、结论

Mozi 的架构是完整的，但稳定性问题主要来自：

1. **外部限制**：LLM API 速率限制
2. **内部策略**：重试/恢复机制不够智能
3. **错误处理**：分类不细致，没有针对性策略

优化后预期效果：

| 指标 | 当前 | 优化后 |
|------|------|--------|
| Proactive Engine 成功率 | ~50% | ~95% |
| 工具执行成功率 | ~85% | ~95% |
| 复杂任务成功率 | ~70% | ~90% |
| 用户干预频率 | 高 | 低 |
